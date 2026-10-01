"""
WatchAI — VLM Scene Analyzer
Sends CCTV frames to Gemini 2.5 Flash for ground-level scene understanding.
Works for any fixed-camera location: bank, street, shop, office, parking lot.

Top-N Frame Selection:
  Instead of throttling by time, the analyzer buffers VLM_FRAME_BUFFER frames,
  scores each by detection richness + image sharpness, and sends the highest-
  scoring frame to Gemini. This ensures the VLM always sees the most informative
  frame from each window, not just a random one.

Falls back to a rule-based description when GEMINI_API_KEY is not set.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

import cv2
import numpy as np

import config

logger = logging.getLogger(__name__)


_last_gemini_call_time = 0.0

@dataclass
class VLMResult:
    description:      str
    threat_level:     str           # LOW | MEDIUM | HIGH
    key_observations: List[str]
    raw_response:     str
    model_used:       str

    def to_dict(self) -> dict:
        return {
            "description":      self.description,
            "threat_level":     self.threat_level,
            "key_observations": self.key_observations,
            "model_used":       self.model_used,
        }


# Type alias for a buffered frame entry
_FrameEntry = Tuple[float, np.ndarray, list, str, str, str]
# (score, image, detections, location, timestamp, camera_id)


class VLMAnalyzer:
    """
    Analyzes a BGR frame from a fixed CCTV camera using Gemini 2.5 Flash.
    Prompt is tuned for ground-level locations (not aerial/drone).

    Top-N frame selection:
      Buffers VLM_FRAME_BUFFER frames per analysis window. When the buffer
      is full, the highest-scoring frame is sent to Gemini. Score is based on:
        - Number of persons detected (weight ×3)
        - Total detection count     (weight ×1)
        - Image sharpness (Laplacian variance — higher = crisper image)
      Between windows the last cached result is returned immediately.
    """

    def __init__(
        self,
        model:         str   = config.VLM_MODEL,
        buffer_size:   int   = config.VLM_FRAME_BUFFER,
    ):
        self.provider     = config.VLM_PROVIDER
        self.model        = config.LOCAL_VLM_MODEL if self.provider == "ollama" else model
        self._buffer_size = buffer_size
        self._buffer:     List[_FrameEntry] = []
        self._cached_result: Optional[VLMResult] = None
        self._api_keys:   List[str] = []
        self._current_key_idx: int = 0

        if self.provider == "ollama":
            self._client = None
            self._available = True
            logger.info(
                f"Local VLM ready: {self.model} (Ollama) "
                f"(top-{buffer_size} frame selection)"
            )
        elif config.GEMINI_API_KEY:
            self._api_keys = [k.strip() for k in config.GEMINI_API_KEY.split(",") if k.strip()]
            try:
                from google import genai
                self._client = genai.Client(
                    api_key=self._api_keys[0] if self._api_keys else None,
                    http_options={"timeout": config.VLM_TIMEOUT * 1000}
                )
                self._available = True
                logger.info(
                    f"Gemini VLM ready: {self.model} ({len(self._api_keys)} API key(s) loaded) "
                    f"(top-{buffer_size} frame selection)"
                )
            except Exception as exc:
                logger.warning(f"Gemini client init failed: {exc}. Using fallback.")
                self._client    = None
                self._available = False
        else:
            self._client    = None
            self._available = False
            logger.warning("GEMINI_API_KEY not set and local VLM not selected. VLM will use fallback descriptions.")

    def analyze(
        self,
        image:      np.ndarray,
        detections:      list,
        location:        str,
        timestamp:       str,
        camera_id:       str = "CAM-01",
        criminal_context: dict | None = None,
        past_context: list[str] | None = None,
        bypass_buffer: bool = False,
    ) -> VLMResult:
        """
        Buffer this frame and return a VLMResult (or bypass and evaluate immediately).
        """
        if not self._available:
            result = self._fallback(detections, location)
            self._cached_result = result
            return result

        if bypass_buffer:
            logger.info(f"[VLM] Bypassing buffer — analyzing frame index immediately")
            result = self._call_gemini(
                image, detections, location, timestamp, camera_id, criminal_context, past_context
            )
            self._cached_result = result
            return result

        # Score and buffer this frame
        score = self._score_frame(image, detections)
        self._buffer.append((
            score, image.copy(), detections,
            location, timestamp, camera_id, criminal_context,
        ))

        logger.debug(
            f"[VLM] Buffered frame score={score:.1f} "
            f"({len(self._buffer)}/{self._buffer_size})"
        )

        # Buffer not full yet — return cached result immediately
        if len(self._buffer) < self._buffer_size:
            if self._cached_result is not None:
                return self._cached_result
            return self._fallback(detections, location)

        # Buffer full — pick the best frame and call Gemini
        best = max(self._buffer, key=lambda e: e[0])
        best_score, best_img, best_dets, best_loc, best_ts, best_cam, best_ctx = best
        self._buffer.clear()

        logger.info(
            f"[VLM] Buffer full — sending best frame "
            f"(score={best_score:.1f}) to Gemini"
            + (f" [criminal_ctx: {best_ctx.get('name')}]" if best_ctx else "")
        )

        result = self._call_gemini(
            best_img, best_dets, best_loc, best_ts, best_cam, best_ctx, past_context
        )
        self._cached_result = result
        return result



    # ── Scoring ───────────────────────────────────────────────────────────────

    @staticmethod
    def _score_frame(image: np.ndarray, detections: list) -> float:
        """
        Score a frame for VLM usefulness.

        Higher = more informative for security analysis:
          - Person count × 3  (face cam: persons are the primary subject)
          - Total detections × 1
          - Image sharpness (Laplacian variance / 50, capped at 10)
            → blurry frames get lower scores even if detections are equal
        """
        person_count = sum(1 for d in detections if d.label == "person")
        total_dets   = len(detections)

        gray      = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        sharpness = min(sharpness / 50.0, 10.0)   # normalise + cap

        return person_count * 3.0 + total_dets * 1.0 + sharpness

    # ── Gemini call ──────────────────────────────────────────────────────────

    def _call_gemini(
        self,
        image:            np.ndarray,
        detections:       list,
        location:         str,
        timestamp:        str,
        camera_id:        str,
        criminal_context: dict | None = None,
        past_context: list[str] | None = None,
    ) -> VLMResult:
        """Send the best frame to Gemini and parse the response."""
        # Daily quota check and rate limit sleep for Gemini
        if self.provider == "gemini":
            global _last_gemini_call_time
            
            # RPM Rate Limit Sleep
            now = time.time()
            elapsed = now - _last_gemini_call_time
            wait_time = config.VLM_CALL_INTERVAL_SECONDS - elapsed
            if wait_time > 0:
                logger.info(f"[VLM] Rate limiting: sleeping {wait_time:.2f}s before Gemini call...")
                time.sleep(wait_time)
            _last_gemini_call_time = time.time()

        # Build YOLO context string
        if detections:
            counts: dict = {}
            for d in detections:
                counts[d.label] = counts.get(d.label, 0) + 1
            yolo_ctx = ", ".join(f"{n} {lbl}(s)" for lbl, n in counts.items())
        else:
            yolo_ctx = "none"

        # ── Build criminal context block (Camera 1 handoff) ──────────────────
        if criminal_context and criminal_context.get("name"):
            ctx = criminal_context
            criminal_block = (
                f"\n--- ⚠ WATCHLIST ALERT FROM CAMERA 1 ---\n"
                f"Biometric match confirmed: {ctx['name']}\n"
                f"Risk Score: {ctx.get('risk_score', '?')}/100 | "
                f"Risk Level: {ctx.get('risk_level', '?')}\n"
                f"Crime Type: {ctx.get('crime_type', 'Unknown')} | "
                f"Legal Status: {ctx.get('legal_status', 'Unknown')}\n"
                f"Face Match Confidence: {ctx.get('face_confidence', 0):.1%}\n"
                f"\nThis person was just detected at the entry point by the close-up "
                f"face recognition camera. You are the wide-angle scene camera.\n"
            )
            threat_instruction = (
                f"Given that a HIGH-RISK known criminal ({ctx['name']}, "
                f"risk={ctx.get('risk_score','?')}/100) has just entered this area:\n"
                f"   - LOW: They appear calm, alone, and not acting suspiciously.\n"
                f"   - MEDIUM: Unusual positioning, watching staff, or loitering near "
                f"restricted areas.\n"
                f"   - HIGH: Active threat behaviour — approaching staff aggressively, "
                f"displaying weapons, or coordinating with others.\n"
            )
        else:
            criminal_block = ""
            threat_instruction = (
                f"   - LOW: Normal activity, nothing suspicious.\n"
                f"   - MEDIUM: Minor anomaly — loitering, unusual gathering, "
                f"vehicle in restricted area, unattended item.\n"
                f"   - HIGH: Active threat — violence, forced entry, dangerous "
                f"object visible, robbery in progress, or serious safety hazard.\n"
            )

        # ── Build temporal history context block ─────────────────────────────
        history_block = ""
        if past_context:
            history_block = "\n--- TEMPORAL HISTORY (EARLIER FRAMES FROM SAME VIDEO) ---\n"
            # Show the last 3 processed peak descriptions as context
            for idx, item in enumerate(past_context[-3:]):
                history_block += f"Previous Frame Observation {idx+1}: {item}\n"

        prompt = (
            f"You are an expert CCTV Security Analyst monitoring a live surveillance feed "
            f"from a fixed ground-level camera.\n\n"
            f"--- CAMERA CONTEXT ---\n"
            f"Location: {location} | Camera: {camera_id} | Time: {timestamp}\n"
            f"Object detector findings: {yolo_ctx}"
            f"{criminal_block}"
            f"{history_block}\n"
            f"--- INSTRUCTIONS ---\n"
            f"1. Analyze the scene. Describe the environment, people present, "
            f"and any activities visible. Use the TEMPORAL HISTORY context above to notice "
            f"ongoing actions, track objects/people, or identify structural patterns in threat development.\n"
            f"2. Identify security concerns: unauthorized access, suspicious behaviour, "
            f"loitering, altercations, unattended bags, vandalism, crowd activity.\n"
            f"3. Assign a THREAT level:\n"
            f"{threat_instruction}\n"
            f"Respond STRICTLY in this format (no markdown bolding on the labels):\n"
            f"DESCRIPTION: <2-3 sentences about the scene and any security concerns>\n"
            f"THREAT: <LOW|MEDIUM|HIGH>\n"
            f"OBSERVATIONS:\n"
            f"- <specific observation 1>\n"
            f"- <specific observation 2>\n"
            f"- <specific observation 3>"
        )

        # Resize to 640px wide for fast Gemini upload
        h, w = image.shape[:2]
        if w > 640:
            image = cv2.resize(image, (640, int(h * 640 / w)))
        _, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        image_bytes = buf.tobytes()

        max_retries = max(1, len(self._api_keys))
        for attempt in range(max_retries + 1):
            try:
                if self.provider == "ollama":
                    import ollama
                    import base64
                    start = time.time()
                    b64_str = base64.b64encode(image_bytes).decode('utf-8')
                    response = ollama.generate(
                        model=self.model,
                        prompt=prompt,
                        images=[b64_str],
                    )
                    elapsed = time.time() - start
                    logger.info(f"[VLM] Local Ollama VLM ({self.model}) inference took {elapsed:.2f}s")
                    raw_text = response.get('response', '')
                    return self._parse(raw_text)
                else:
                    from google.genai import types
                    start    = time.time()
                    response = self._client.models.generate_content(
                        model=self.model,
                        contents=[
                            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
                            prompt,
                        ],
                    )
                    elapsed = time.time() - start
                    logger.info(f"[VLM] Gemini inference took {elapsed:.2f}s")
                    return self._parse(response.text)

            except Exception as exc:
                err_str = str(exc).lower()
                is_rate_limit = any(term in err_str for term in ["429", "resourceexhausted", "quota", "rate limit"])
                if is_rate_limit:
                    # Dynamically reload .env to pick up newly pooled API keys without restarting server
                    from dotenv import load_dotenv
                    import importlib
                    load_dotenv(override=True)
                    importlib.reload(config)
                    self._api_keys = [k.strip() for k in config.GEMINI_API_KEY.split(",") if k.strip()]
                    max_retries = max(1, len(self._api_keys))

                if is_rate_limit and attempt < max_retries:
                    if len(self._api_keys) > 1:
                        self._current_key_idx = (self._current_key_idx + 1) % len(self._api_keys)
                        new_key = self._api_keys[self._current_key_idx]
                        logger.warning(f"[VLM] Rate limit hit on current API key. Rotating to API key index {self._current_key_idx}...")
                        from google import genai
                        self._client = genai.Client(api_key=new_key, http_options={"timeout": config.VLM_TIMEOUT * 1000})
                        continue
                    else:
                        logger.warning(f"[VLM] Rate limit encountered ({exc}). Waiting 60s before retrying...")
                        time.sleep(60.0)
                        continue
                logger.error(f"[VLM] Gemini error: {exc}")
                fallback = self._fallback(detections, location)
                # Keep last good result on error rather than downgrading
                return self._cached_result if self._cached_result is not None else fallback

    # ── Parsing ───────────────────────────────────────────────────────────────

    def _parse(self, raw: str) -> VLMResult:
        description   = raw[:300]
        threat_level  = "LOW"
        observations: List[str] = []
        obs_mode = False

        for line in raw.strip().splitlines():
            line = line.strip()
            if line.startswith("DESCRIPTION:"):
                description = line.removeprefix("DESCRIPTION:").strip()
                obs_mode = False
            elif line.startswith("THREAT:"):
                level = line.removeprefix("THREAT:").strip().upper()
                if level in ("LOW", "MEDIUM", "HIGH"):
                    threat_level = level
                obs_mode = False
            elif line.startswith("OBSERVATIONS:"):
                obs_mode = True
            elif obs_mode and line.startswith("-"):
                observations.append(line[1:].strip())

        return VLMResult(
            description=description,
            threat_level=threat_level,
            key_observations=observations[:3],
            raw_response=raw,
            model_used=self.model,
        )

    # ── Fallback ─────────────────────────────────────────────────────────────

    def _fallback(self, detections: list, location: str) -> VLMResult:
        """Rule-based fallback when Gemini is not available."""
        labels = [d.label for d in detections]
        if not labels:
            desc   = f"No objects detected at {location}. Scene appears clear."
            threat = "LOW"
            obs    = ["No objects detected", "Scene is clear"]
        else:
            obj_str = ", ".join(set(labels))
            desc    = f"Detected {obj_str} at {location}."
            threat  = "MEDIUM" if "person" in labels else "LOW"
            obs     = [f"{lbl} detected" for lbl in set(labels)][:3]

        return VLMResult(
            description=desc,
            threat_level=threat,
            key_observations=obs,
            raw_response="[FALLBACK — no Gemini API key]",
            model_used="fallback",
        )
