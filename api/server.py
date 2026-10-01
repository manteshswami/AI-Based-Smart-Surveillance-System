"""
WatchAI — FastAPI Backend Server
Runs the surveillance pipeline in a background thread and exposes:
  REST  : /control, /events, /alerts, /criminals, /summary, /agent/chat
  WS    : /ws/feed  — streams JPEG frames + event metadata in real-time
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import sys
import threading
from pathlib import Path
from typing import Optional

import cv2
import shutil
from dotenv import load_dotenv
from fastapi import FastAPI, Form, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── path setup ────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

import config  # noqa: E402

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="WatchAI API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Shared pipeline state (thread-safe) ──────────────────────────────────────
_state: dict = {
    "running":     False,
    "source":      0,
    "location":    config.CAMERA_LOCATIONS.get(0, config.DEFAULT_LOCATION),
    "camera_id":   "CAM-A",
    "camera_role": config.ROLE_FACE,
}
_state_lock    = threading.Lock()
_frame_queue: queue.Queue = queue.Queue(maxsize=3)
_pipeline_thread: Optional[threading.Thread]  = None

# ── Cross-camera shared alert state ──────────────────────────────────────────
# Camera 1 (face cam) writes here when it finds a criminal match.
# Camera 2 (scene cam) reads here to enrich its VLM prompt.
# Expires after _CROSS_CAM_TTL seconds so stale matches don't linger.
import time as _time
_CROSS_CAM_TTL = 30  # seconds a face-match stays "active" for Cam2
_cross_cam_state: dict = {}
_cross_cam_lock = threading.Lock()


def _set_criminal_context(name: str, profile: dict, risk_score: int, risk_level: str, face_conf: float):
    """Called by Camera 1 pipeline when a criminal is recognised."""
    with _cross_cam_lock:
        _cross_cam_state.update({
            "name":           name,
            "risk_score":     risk_score,
            "risk_level":     risk_level,
            "crime_type":     profile.get("crime_type", "Unknown"),
            "legal_status":   profile.get("legal_status", "Unknown"),
            "face_confidence": face_conf,
            "detected_at":    _time.time(),
        })


def _get_criminal_context() -> dict | None:
    """Called by Camera 2 pipeline. Returns context if still within TTL, else None."""
    with _cross_cam_lock:
        if not _cross_cam_state or not _cross_cam_state.get("name"):
            return None
        age = _time.time() - _cross_cam_state.get("detected_at", 0)
        if age > _CROSS_CAM_TTL:
            return None
        return dict(_cross_cam_state)


def _clear_criminal_context():
    with _cross_cam_lock:
        _cross_cam_state.clear()


# Second pipeline for Camera 2 (scene cam)
_pipeline_thread2: Optional[threading.Thread] = None
_state2: dict = {}  # populated when dual-cam mode is started


# ── Pipeline worker (background thread) ──────────────────────────────────────

def _pipeline_worker(state_ref: dict, state_lock: threading.Lock, is_cam2: bool = False):
    """Runs the full surveillance pipeline in a background thread.
    
    For Camera 1 (face cam, is_cam2=False):
      - Runs face recognition
      - On criminal match, writes to _cross_cam_state for Camera 2 to consume
    
    For Camera 2 (scene cam, is_cam2=True):
      - Reads _cross_cam_state (if within TTL) and injects into VLM prompt
      - Independent scene analysis — catches what Camera 1 misses
    """
    from main import run_pipeline_step, load_singletons

    load_singletons()

    with state_lock:
        src      = state_ref["source"]
        location = state_ref["location"]
        cam_id   = state_ref["camera_id"]
        cam_role = state_ref["camera_role"]

    raw_src = int(src) if str(src).isdigit() else src
    cap = cv2.VideoCapture(raw_src)

    if not cap.isOpened():
        print(f"[API] ERROR: Cannot open source {src}", flush=True)
        with state_lock:
            state_ref["running"] = False
        return

    label = "CAM2-SCENE" if is_cam2 else "CAM1-FACE"
    print(f"[API] {label} started — source={src} role={cam_role}", flush=True)
    frame_id = 0

    try:
        while True:
            with state_lock:
                running = state_ref["running"]
            if not running:
                break

            frame_id += 1
            if frame_id % config.PROCESS_EVERY_N_FRAMES != 0:
                cap.read()
                continue

            # Camera 2 reads criminal context written by Camera 1
            criminal_context = _get_criminal_context() if is_cam2 else None

            event = run_pipeline_step(
                cap=cap,
                frame_id=frame_id,
                location=location,
                camera_id=cam_id,
                camera_role=cam_role,
                criminal_context=criminal_context,
            )

            if event is None:
                import time
                time.sleep(0.03)
                continue

            # Camera 1: if criminal matched, publish to cross-cam state
            if not is_cam2 and event.get("criminal_name"):
                from main import _profiles
                from services.risk_engine import calculate_risk
                name    = event["criminal_name"]
                profile = _profiles.get(name, {}) if _profiles else {}
                _set_criminal_context(
                    name=name,
                    profile=profile,
                    risk_score=event.get("risk_score", 0),
                    risk_level=event.get("risk_level", "LOW"),
                    face_conf=event.get("face_confidence", 0.0),
                )
                print(f"[CAM1→CAM2] Criminal context published: {name}", flush=True)

            # Encode annotated frame to base64 JPEG for WebSocket
            disp = event.pop("display_frame", None)
            if disp is not None:
                _, buf = cv2.imencode(
                    ".jpg", disp, [cv2.IMWRITE_JPEG_QUALITY, 75]
                )
                event["frame_b64"] = base64.b64encode(buf.tobytes()).decode()

            # Tag which camera produced this event
            event["stream_source"] = "cam2_scene" if is_cam2 else "cam1_face"

            # Non-blocking queue push — drop oldest if full
            try:
                _frame_queue.put_nowait(event)
            except queue.Full:
                try:
                    _frame_queue.get_nowait()
                except queue.Empty:
                    pass
                _frame_queue.put_nowait(event)

    except Exception as exc:
        import traceback
        print(f"[API] {label} pipeline error: {exc}", flush=True)
        traceback.print_exc()
    finally:
        cap.release()
        print(f"[API] {label} pipeline stopped.", flush=True)


def _start_pipeline():
    """Start Camera 1 (and Camera 2 if _state2 is populated)."""
    global _pipeline_thread, _pipeline_thread2

    # Camera 1
    if not (_pipeline_thread and _pipeline_thread.is_alive()):
        _pipeline_thread = threading.Thread(
            target=_pipeline_worker,
            args=(_state, _state_lock, False),
            daemon=True,
        )
        _pipeline_thread.start()

    # Camera 2 (only if configured)
    if _state2 and not (_pipeline_thread2 and _pipeline_thread2.is_alive()):
        _state2_lock = threading.Lock()
        _pipeline_thread2 = threading.Thread(
            target=_pipeline_worker,
            args=(_state2, _state2_lock, True),
            daemon=True,
        )
        _pipeline_thread2.start()


def _stop_pipeline():
    with _state_lock:
        _state["running"] = False
    if _state2:
        _state2["running"] = False
    _clear_criminal_context()


# ── Request models ────────────────────────────────────────────────────────────

class ControlRequest(BaseModel):
    action:      str             # "start" | "stop" | "reset"
    source:      Optional[int | str] = 0
    camera_role: Optional[str]  = config.ROLE_BOTH
    location:    Optional[str]  = None
    camera_id:   Optional[str]  = "CAM-A"

class ChatRequest(BaseModel):
    message: str
    thread_id: Optional[str] = "default"


class AnalyzeVideoRequest(BaseModel):
    source:      str
    location:    Optional[str] = "Uploaded Video"
    camera_role: Optional[str] = config.ROLE_BOTH
    camera_id:   Optional[str] = "BATCH-CAM"


# ── REST endpoints ────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    with _state_lock:
        return {"status": "ok", "running": _state["running"]}



@app.post("/upload_video")
async def upload_video(file: UploadFile = File(...)):
    videos_dir = ROOT / "videos"
    videos_dir.mkdir(exist_ok=True)
    file_path = videos_dir / file.filename
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    return {
        "status":   "uploaded",
        "source":   str(file_path),
        "filename": file.filename,
    }


@app.post("/check_face")
async def check_face(file: UploadFile = File(...)):
    """
    Camera 1 — Check if a face in an uploaded image matches any criminal.
    Returns: match status, criminal name, confidence, risk score/level.
    """
    import numpy as np
    import face_recognition as fr

    # Read image bytes and decode with face_recognition
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    import cv2 as _cv2
    img_bgr = _cv2.imdecode(nparr, _cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise HTTPException(status_code=400, detail="Could not decode image. Send a valid JPG/PNG.")

    img_rgb = _cv2.cvtColor(img_bgr, _cv2.COLOR_BGR2RGB)

    # Detect face encodings
    encodings = fr.face_encodings(img_rgb)
    if not encodings:
        return {
            "matched":     False,
            "face_found":  False,
            "message":     "No face detected in the uploaded image.",
            "name":        None,
            "confidence":  0.0,
            "risk_score":  0,
            "risk_level":  "LOW",
        }

    query_enc = encodings[0]

    # Load singletons (ensures criminal encodings are loaded)
    from main import load_singletons, _encodings, _names, _profiles
    load_singletons()

    # Re-import after load to get populated values
    import main as _main
    known_encs  = _main._encodings or []
    known_names = _main._names     or []
    profiles    = _main._profiles  or {}

    if not known_encs:
        return {
            "matched":    False,
            "face_found": True,
            "message":    "Criminal database is empty.",
            "name":       None,
            "confidence": 0.0,
            "risk_score": 0,
            "risk_level": "LOW",
        }

    # Compare distances (lower = more similar)
    distances = fr.face_distance(known_encs, query_enc)
    best_idx  = int(np.argmin(distances))
    best_dist = float(distances[best_idx])
    threshold = float(config.FACE_DISTANCE_THRESHOLD) if hasattr(config, "FACE_DISTANCE_THRESHOLD") else 0.50

    matched = best_dist <= threshold
    name    = known_names[best_idx] if matched else None
    conf    = round(max(0.0, 1.0 - best_dist) * 100, 1)

    risk_score, risk_level = 0, "LOW"
    profile = {}
    if matched and name:
        profile = profiles.get(name, {})
        from services.risk_engine import calculate_risk
        risk_score, risk_level = calculate_risk(profile)

    return {
        "matched":     matched,
        "face_found":  True,
        "name":        name,
        "confidence":  conf,
        "risk_score":  risk_score,
        "risk_level":  risk_level,
        "crime_type":  profile.get("crime_type", ""),
        "legal_status": profile.get("legal_status", ""),
        "message":     f"Match: {name} ({conf}% confidence)" if matched else "No criminal match found.",
    }


@app.post("/enroll_criminal")
async def enroll_criminal(
    name:  str             = Form(...),
    files: list[UploadFile] = File(...),
):
    """
    Camera 1 — Enroll a criminal's face images.
    Saves images to criminal_images/{name}/ and hot-reloads face encodings.
    Accepts multipart form: name (str) + files (one or more images).
    """
    if not name or not name.strip():
        raise HTTPException(status_code=400, detail="Criminal name is required.")

    # Sanitize name: lowercase, underscores, no spaces
    safe_name = name.strip().lower().replace(" ", "_")
    person_dir = ROOT / "criminal_images" / safe_name
    person_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    errors = []
    for file in files:
        ext = Path(file.filename).suffix.lower()
        if ext not in (".jpg", ".jpeg", ".png", ".bmp"):
            errors.append(f"{file.filename} — unsupported format (use jpg/png)")
            continue

        # Auto-number: find next index
        existing = sorted(person_dir.glob("*.jpg")) + sorted(person_dir.glob("*.png"))
        idx = len(existing) + 1
        out_path = person_dir / f"{idx:03d}{ext}"
        with open(out_path, "wb") as buf:
            shutil.copyfileobj(file.file, buf)
        saved.append(out_path.name)

    if not saved:
        raise HTTPException(status_code=400, detail=f"No valid images saved. Errors: {errors}")

    # ── Hot-reload face encodings in main.py singletons ──────────────────────
    try:
        import main as _main
        from utilis.encoder_preload import load_criminal_encodings
        encs, names, profiles = load_criminal_encodings()
        _main._encodings = encs
        _main._names     = names
        _main._profiles  = profiles
        print(f"[ENROLL] Hot-reloaded {len(names)} criminal(s) after enrolling '{safe_name}'", flush=True)
    except Exception as exc:
        print(f"[ENROLL] Warning: hot-reload failed — {exc}", flush=True)

    return {
        "status":       "enrolled",
        "name":         safe_name,
        "images_saved": saved,
        "total_images": len(list(person_dir.glob("*.*"))),
        "errors":       errors,
    }


@app.get("/enrolled_criminals")
def list_enrolled_criminals():
    """List all currently enrolled criminals with their image counts."""
    criminals_dir = ROOT / "criminal_images"
    if not criminals_dir.exists():
        return {"criminals": []}

    result = []
    for d in sorted(criminals_dir.iterdir()):
        if d.is_dir():
            imgs = [f for f in d.iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".bmp")]
            result.append({"name": d.name, "image_count": len(imgs)})
    return {"criminals": result}


def _batch_analyze_worker(source: str, location: str, camera_role: str, camera_id: str):
    import cv2
    import numpy as np
    import base64
    from pathlib import Path
    from main import run_pipeline_step, load_singletons

    load_singletons()
    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"[BATCH] Error: Cannot open video source {source}", flush=True)
        _frame_queue.put({"type": "batch_error", "message": f"Cannot open video source: {source}"})
        return

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    video_duration_sec = total_frames / fps
    print(f"[BATCH] Analyzing {source}: {total_frames} frames, {fps} FPS, {video_duration_sec:.1f}s duration", flush=True)

    # Scan every 1s of frames for files under 3 minutes, else every 2s
    if video_duration_sec < 180:
        step_size = int(fps)
    else:
        step_size = int(fps * 2)

    if step_size < 1:
        step_size = 30

    candidates = []
    prev_gray = None

    frame_idx = 0
    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret or frame is None:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray_resized = cv2.resize(gray, (320, 240))

        motion_score = 0.0
        if prev_gray is not None:
            diff = cv2.absdiff(prev_gray, gray_resized)
            _, diff_thresh = cv2.threshold(diff, 20, 255, cv2.THRESH_BINARY)
            motion_score = float(np.sum(diff_thresh) / 255.0)

        prev_gray = gray_resized
        laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()

        candidates.append({
            "frame_idx": frame_idx,
            "motion_score": motion_score,
            "sharpness": laplacian_var,
        })

        progress = int((frame_idx / max(total_frames, 1)) * 50)
        _frame_queue.put({
            "type": "batch_progress",
            "percent": progress,
            "phase": "Scanning scene change indices..."
        })

        frame_idx += step_size
        if frame_idx >= total_frames:
            break

    peaks = []
    if len(candidates) > 2:
        for i in range(1, len(candidates) - 1):
            prev = candidates[i-1]["motion_score"]
            curr = candidates[i]["motion_score"]
            nxt  = candidates[i+1]["motion_score"]
            if curr > prev and curr > nxt and curr > 500:
                peaks.append(candidates[i])

    # Dynamic target peaks: 1 frame every 6 seconds. (e.g. 80s video = 13 frames)
    max_peaks = max(5, min(25, int(video_duration_sec // 6)))

    if not peaks:
        sorted_cands = sorted(candidates, key=lambda x: x["sharpness"], reverse=True)
        peaks = sorted_cands[:max_peaks]
    else:
        peaks = sorted(peaks, key=lambda x: x["motion_score"], reverse=True)[:max_peaks]
        peaks = sorted(peaks, key=lambda x: x["frame_idx"])

    print(f"[BATCH] Selected {len(peaks)} peak frames (max={max_peaks}): {[p['frame_idx'] for p in peaks]}", flush=True)

    processed_events = []
    past_descriptions = []
    for i, peak in enumerate(peaks):
        fid = peak["frame_idx"]
        # Set pos to fid - run_pipeline_step calls cap.read() directly to ingest it without duplicating read calls
        cap.set(cv2.CAP_PROP_POS_FRAMES, fid)

        event = run_pipeline_step(
            cap=cap,
            frame_id=fid,
            location=location,
            camera_id=camera_id,
            camera_role=camera_role,
            skip_motion=True,
            past_context=past_descriptions,
            bypass_buffer=True,
        )

        if event:
            disp = event.pop("display_frame", None)
            if disp is not None:
                _, buf = cv2.imencode(".jpg", disp, [cv2.IMWRITE_JPEG_QUALITY, 75])
                event["frame_b64"] = base64.b64encode(buf.tobytes()).decode()
            processed_events.append(event)
            
            # Store VLM description for subsequent frames context
            desc = event.get("vlm_description")
            if desc:
                past_descriptions.append(desc)

        progress = 50 + int(((i + 1) / len(peaks)) * 50)
        _frame_queue.put({
            "type": "batch_progress",
            "percent": progress,
            "phase": f"Processing event peak {i+1} of {len(peaks)}..."
        })

    cap.release()

    print(f"[BATCH] Analysis complete. Generated {len(processed_events)} events.", flush=True)
    _frame_queue.put({
        "type": "batch_complete",
        "events": processed_events,
        "filename": Path(source).name
    })


@app.post("/analyze_video")
def analyze_video(req: AnalyzeVideoRequest):
    _stop_pipeline()
    t = threading.Thread(
        target=_batch_analyze_worker,
        args=(req.source, req.location, req.camera_role, req.camera_id),
        daemon=True
    )
    t.start()
    return {"status": "started", "source": req.source}


@app.post("/control")
def control(req: ControlRequest):
    global _pipeline_thread, _state2

    if req.action == "start":
        if isinstance(req.source, str) and not req.source.isdigit():
            raise HTTPException(
                status_code=400,
                detail="Live streaming is not supported for video files. Use /analyze_video instead."
            )

        loc = req.location or config.CAMERA_LOCATIONS.get(
            req.source if isinstance(req.source, int) else 0,
            config.DEFAULT_LOCATION,
        )
        with _state_lock:
            _state["source"]      = req.source
            _state["location"]    = loc
            _state["camera_id"]   = req.camera_id or "CAM-A"
            _state["camera_role"] = req.camera_role or config.ROLE_BOTH
            _state["running"]     = True

        # ── Dual-cam mode: auto-configure Camera 2 as scene cam ──────────────
        # If Camera 1 is a face cam (source=0), Camera 2 is source=1 scene cam.
        # This follows the user-designed architecture:
        #   Cam1 (close-up face) → publishes criminal context
        #   Cam2 (wide-angle scene) → receives context, does independent VLM scan
        cam1_src = req.source
        if req.camera_role == config.ROLE_FACE and isinstance(cam1_src, int):
            cam2_src  = cam1_src + 1
            cam2_loc  = config.CAMERA_LOCATIONS.get(cam2_src, f"{loc} — Wide Angle")
            _state2.update({
                "source":      cam2_src,
                "location":    cam2_loc,
                "camera_id":   f"CAM-{cam2_src}-SCENE",
                "camera_role": config.ROLE_SCENE,
                "running":     True,
            })
            print(f"[API] Dual-cam mode: Cam1={cam1_src}(face) Cam2={cam2_src}(scene)", flush=True)
        else:
            _state2.clear()  # single-cam mode

        _start_pipeline()
        return {
            "status":   "started",
            "source":   req.source,
            "role":     req.camera_role,
            "dual_cam": bool(_state2),
        }

    elif req.action == "stop":
        _stop_pipeline()
        return {"status": "stopped"}

    elif req.action == "reset":
        _stop_pipeline()
        _state2.clear()
        while not _frame_queue.empty():
            try:
                _frame_queue.get_nowait()
            except queue.Empty:
                break
        return {"status": "reset"}

    return {"error": f"Unknown action: {req.action}"}



@app.get("/events")
def get_events(limit: int = 50):
    from services.database import FrameIndexer
    idx = FrameIndexer()
    rows = idx.get_all_frames(limit=limit)
    return {"events": rows}


@app.get("/alerts")
def get_alerts(severity: str = "", limit: int = 20):
    from services.database import FrameIndexer
    idx = FrameIndexer()
    sev = severity.upper() or None
    if sev not in (None, "HIGH", "MEDIUM", "LOW", "CRITICAL"):
        sev = None
    alerts = idx.get_all_alerts(severity=sev)[:limit]
    return {"alerts": alerts}


@app.get("/criminals")
def get_criminals():
    from services.database import FrameIndexer
    idx = FrameIndexer()
    rows = idx.get_all_frames(limit=500)
    matches = [r for r in rows if r.get("criminal_name")]
    return {"criminal_events": matches}


@app.get("/summary")
def get_summary():
    from services.database import FrameIndexer
    idx = FrameIndexer()
    return idx.get_daily_summary()


@app.post("/agent/chat")
def agent_chat(req: ChatRequest):
    try:
        from services.security_agent import build_agent, fallback_agent_response
        agent = build_agent()
        if agent is None:
            return {"response": fallback_agent_response(req.message)}
        result = agent.invoke(
            {"messages": [{"role": "user", "content": req.message}]},
            config={"configurable": {"thread_id": req.thread_id}},
        )
        msgs = result.get("messages", [])
        reply = msgs[-1].content if msgs else "No response."
        return {"response": reply}
    except Exception as exc:
        import traceback
        print(f"[AGENT ERROR] {exc}", flush=True)
        traceback.print_exc()
        from services.security_agent import fallback_agent_response
        return {"response": fallback_agent_response(req.message)}


@app.get("/cameras")
def get_cameras():
    """Return available camera presets from config."""
    presets = []
    role_label = {
        config.ROLE_FACE:  "Face Cam",
        config.ROLE_SCENE: "Scene Cam",
        config.ROLE_BOTH:  "Full Pipeline",
    }
    for src, role in config.CAMERA_ROLES.items():
        loc = config.CAMERA_LOCATIONS.get(src, config.DEFAULT_LOCATION)
        presets.append({
            "source":      src,
            "role":        role,
            "role_label":  role_label.get(role, role),
            "location":    loc,
            "camera_id":   f"CAM-{str(src).upper()[:6]}",
        })
    return {"cameras": presets}


# ── WebSocket feed ────────────────────────────────────────────────────────────

@app.websocket("/ws/feed")
async def ws_feed(websocket: WebSocket):
    """
    Streams surveillance events to the React frontend.
    Each message is a JSON object:
      { frame_b64: "<base64 JPEG>", event: { ...metadata... } }
    """
    await websocket.accept()
    loop = asyncio.get_event_loop()
    try:
        while True:
            # Poll the frame queue without blocking the event loop
            try:
                event = await loop.run_in_executor(
                    None, lambda: _frame_queue.get(timeout=0.5)
                )
                payload = json.dumps(event, default=str)
                await websocket.send_text(payload)
            except queue.Empty:
                # Send a heartbeat so the client knows we're alive
                try:
                    await asyncio.wait_for(
                        websocket.send_text('{"heartbeat":true}'), timeout=1.0
                    )
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[WS] Error: {exc}")
