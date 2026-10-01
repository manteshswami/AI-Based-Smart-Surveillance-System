# 🎯 WatchAI — Dual-Camera Context-Aware CCTV Surveillance System

WatchAI is a real-time, AI-powered ground-level CCTV surveillance and threat intelligence system designed for physical security environments such as banks, street junctions, retail shops, parking lots, and ATM vestibules.

The platform fuses biometrics, object detection, cloud-scale Vision-Language Models (VLMs), and local LLM agents to bridge the gap between individual cameras, enabling collaborative, context-aware physical threat monitoring and semantic log search.

---

## 🏗️ Core Architecture & Design

WatchAI transitions CCTV monitoring from isolated, passive video capture to a collaborative, semantic threat-intelligence system through four architectural pillars:

```
                  ┌───────────────────────────────────────────────┐
                  │           ZONE (e.g., Bank Branch)            │
                  │                                               │
                  │  CAM-A (Close-up)         CAM-B (Wide-angle)  │
                  │  Entry Point / Counter    Full Area Overview  │
                  └─────────┬─────────────────────────┬───────────┘
                            │                         │
                            ▼                         ▼
                      Face Recognition         VLM Scene Analysis
                    (dlib HOG Landmark)        (Gemini 2.5 Flash)
                            │                         │
                            │  [30s TTL Context]      │
                            └────────────────────────►│ (suspect profile
                                                      │  injected into prompt)
                                                      ▼
                                              Threat Assessment
                                              (LOW/MEDIUM/HIGH)
                                                      │
                                                      ▼
                                            Alert Engine (8 Rules)
                                                      │
                                            ┌─────────┴─────────┐
                                            ▼                   ▼
                                      SQLite Event Log    ChromaDB Vector
                                      (relational)        (nomic-embed-text)
                                            │                   │
                                            └─────────┬─────────┘
                                                      ▼
                                           LangGraph Security Agent
                                            (Ollama llama3.2:1b)
                                                      │
                                                      ▼
                                            React Dark Dashboard
```

### 1. Active Suspect Security Analysis & Assessment (ASSAA)
監視 zones are equipped with **paired cameras working in tandem**:
* **Camera 1 (Close-up Face Cam - `ROLE_FACE`)**: Focuses on entrances or high-traffic bottlenecks. It runs high-frequency local face recognition against the enrolled suspect watchlist database. On a match, it writes the suspect profile metadata (name, legal status, crime classification, prior convictions, victim counts, and computed risk score) to a thread-safe global cache.
* **Camera 2 (Wide-angle Scene Cam - `ROLE_SCENE`)**: Monitors the wider layout. It runs VLM situational analysis. It automatically checks the shared cache. If a suspect was matched within the **30-second Time-to-Live (TTL)**, it retrieves their profile and injects it as temporal context into the prompt for Gemini. This allows the VLM to perform targeted threat assessments (e.g., distinguishing normal movement from hostile posturing by a known offender).

### 2. Top-N Frame Selection Buffer
To eliminate cloud VLM API rate limits (or local GPU load) and reduce token costs, WatchAI implements an intelligent frame aggregator:
* The system buffers frames in windows of `VLM_FRAME_BUFFER = 10` frames.
* Each frame is evaluated and scored using a quality-of-interest formula:
  
  $$\text{Score} = (\text{Person Count} \times 3.0) + (\text{Other Detections} \times 1.0) + \min\left(\frac{\text{Var}(\text{Laplacian})}{50.0}, 10.0\right)$$
  
  * *Person Count* prioritizes suspect actions.
  * *Other Detections* values scene complexity.
  * *Laplacian Variance* measures image sharpness to discard blurry motion artifacts.
* Once the buffer fills, the highest-scoring frame is sent to the VLM, while the system serves the cached analysis results for intermediate frames.
* **Rate Limiting & API Key Rotation**: Includes a rate limiter (`VLM_CALL_INTERVAL_SECONDS = 12.0`) and rotates through a comma-separated list of Gemini API keys configured in `.env` if rate limits (`429`) are hit.

### 3. Hybrid Storage & Semantic Vector Index
Surveillance logs are indexed into two layers:
* **SQLite Relational Layer (`watchai_security.db`)**: Stores structured telemetry (timestamp, location, camera role, detected object counts, criminal name, risk score, and triggered alerts) for fast database querying.
* **ChromaDB Vector Layer**: Generates 768-dimensional embeddings of VLM-generated descriptions using `nomic-embed-text` through local Ollama. This permits operators to query logs via natural language semantic search (e.g., *"Show me unauthorized vehicles parked near the reception gate during late night hours"*).

### 4. LangGraph Security Analyst Agent
Equipped with a local model (Ollama `llama3.2:1b`), the agent uses a stateful ReAct loop to call system database tools:
* `summarize_today`: Aggregates the daily telemetry, alert frequency, and object count.
* `semantic_search`: Performs vector search queries on ChromaDB.
* `query_criminal_alerts`: Filters log databases for incidents related to a specific suspect.
* `get_risk_breakdown`: Retrieves a suspect's prior offense and risk score profile.
* `get_alerts`: Lists recent alerts filtered by severity.

---

## 🚀 Setup & Installation

### Prerequisites
* **Python 3.12+**
* **`uv`** (Python package manager)
* **Node.js v18+** & **npm** (for React frontend)
* **Ollama** running locally (loaded with `llama3.2:1b` and `nomic-embed-text`)
* **Google Gemini API Key(s)** (optional; falls back to rule-based description if not set)

### Installation

1. **Clone and install dependencies**:
   ```bash
   uv sync
   ```

2. **Pull local models via Ollama**:
   ```bash
   ollama pull llama3.2:1b
   ollama pull nomic-embed-text
   ```

3. **Configure Environment Variables**:
   Create a `.env` file from the template:
   ```bash
   cp .env.example .env
   ```
   Add your keys:
   ```env
   GEMINI_API_KEY=your_gemini_key_1,your_gemini_key_2
   VLM_MODEL=gemini-2.5-flash
   AGENT_LLM_MODEL=llama3.2:1b
   OLLAMA_BASE_URL=http://localhost:11434
   ```

---

## 🗂️ Project Structure

```
watch-dog-ai/
├── api/
│   └── server.py            # FastAPI App, WS Stream Thread & Shared Cache
├── app/
│   ├── display.py           # OpenCV Bounding Box & HUD Rendering
│   └── streamlit_app_legacy.py # Legacy fallback Streamlit UI
├── config.py                # Central Parameters (Thresholds, Roles, Rules)
├── criminals/
│   └── criminals.xlsx       # Criminal watchlist profile registry
├── criminal_images/         # Enrollment directories (e.g., /john_doe/001.jpg)
├── data/                    # Local storage (created at runtime)
│   ├── db/                  # watchai_security.db & chromadb/
│   ├── frames/              # JPEG event crops
│   └── logs/                # events.json, alerts.log
├── frontend/                # React Dashboard App
│   ├── src/
│   │   ├── components/      # Tab panes (LiveMonitor, AlertFeed, AgentChat, etc.)
│   │   ├── App.jsx          # Root Layout & WebSocket controller
│   │   └── api.js           # Axios integration layer
│   └── package.json
├── main.py                  # Pipeline Runner (Motion -> YOLO -> Face -> VLM -> Index)
├── scripts/
│   ├── build_dataset.py     # Encodes faces and imports profiles from Excel
│   └── test_face_recognition.py # Runs test suites for biometric accuracy
├── pyproject.toml
└── requirements.txt
```

---

## 🔌 API Specifications (FastAPI Backend)

The backend (`api.server:app`) coordinates live streams, runs the background thread worker pipelines, and hosts REST + WebSocket ports.

### REST Endpoints

* **`POST /control`**: Orchestrates streams.
  * **Payload**: `{"action": "start"|"stop"|"reset", "source": 0, "camera_role": "face"|"scene"|"both", "location": "Bank Entrance"}`
  * *Note*: Specifying `camera_role="face"` auto-spins a second concurrent thread for `source + 1` with `ROLE_SCENE` to initiate dual-camera mode.
* **`POST /upload_video`**: Stores an uploaded `.mp4` file in `videos/`.
* **`POST /analyze_video`**: Runs high-speed batch processing. Extracts motion-heavy and sharp scene changes, runs VLM analysis with temporal history injection, and commits results to index databases.
* **`POST /enroll_criminal`**: Creates a folder in `criminal_images/` for a suspect, saves uploaded photos, and hot-reloads the biometric `dlib` memory mapping.
* **`POST /check_face`**: Uploads a single image to test face-match metrics and retrieve suspect risk profiles immediately.
* **`GET /events`**: Lists indexed frames.
* **`GET /alerts`**: Retrieves log entries filterable by severity status.
* **`GET /summary`**: Queries the database to build a daily aggregation report.
* **`POST /agent/chat`**: Dispatches a question to the LangGraph/Ollama agent. Falls back to keyword-based database searches if the LLM is offline.

### WebSocket Interface

* **`WS /ws/feed`**: Broadcasts active event packages. The React client establishes a connection that streams base64-encoded frame images and metadata. Includes a `heartbeat` mechanism to check connection health.

---

## 🔔 Surveillance Alert Rules Matrix

WatchAI runs events through a grading engine checking 8 critical rules:

| Rule ID | Trigger Condition | Severity | Primary Target |
|:---|:---|:---|:---|
| **after_hours_loitering** | Person detected outside business hours (22:00 - 05:00) | **HIGH** | `person` |
| **unauthorized_vehicle_after_hours** | Vehicle detected after closing hours (20:00 - 06:00) | **MEDIUM** | `car`/`motorcycle` |
| **crowd_gathering** | 5 or more people detected simultaneously | **MEDIUM** | `person` |
| **vlm_high_threat** | VLM returns `threat_level="HIGH"` | **HIGH** | Scene Dynamics |
| **criminal_face_match** | Biometric recognition matches known suspect profile | **HIGH** | Suspect Profile |
| **critical_risk_criminal** | Identified suspect has computed risk score $\ge 76$ | **CRITICAL** | Suspect Profile |
| **criminal_high_threat_scene** | Suspect present during a HIGH-threat VLM incident | **CRITICAL** | Suspect + VLM |
| **dual_cam_confirmation** | Overview scene camera confirms suspect within TTL window | **CRITICAL** | Cross-Camera sync |

### Risk Score Calculation
Suspect profiles are scored dynamically using the following weights:
1. **Legal Status**: Wanted (+35) | Bail (+25) | Parole (+15) | Released (+5) | Imprisoned (+0).
2. **Offense History Severity**: Sexual (+25) | Violent (+20) | Drug (+10) | Fraud (+7) | Property (+5) | Non-violent (+2).
3. **Weapon History**: Brandished or used during past arrest (+10).
4. **Prior Convictions**: +3 per conviction (capped at +15).
5. **Victim Counts**: +1 per victim (capped at +10).
6. **Recency**: Incident under 1 year (+20) | 1-3 years (+12) | 3-5 years (+6).
7. **Youth/Recidivism Bonus**: Age < 25 with 2+ priors (+5).

---

## 💻 Running the Application

### 1. Register Watchlist Suspects
1. Place suspect photo directories inside `criminal_images/` (e.g., `criminal_images/elias_thorne/shot1.jpg`).
2. Add profile metadata matching the directories inside `criminals/criminals.xlsx`.
3. Process and compile biometric descriptors:
   ```bash
   uv run python scripts/build_dataset.py
   ```

### 2. Start the Backend API Server
```bash
uv run uvicorn api.server:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Start the React Frontend Dashboard
```bash
cd frontend
npm install
npm run dev
```
Open your browser at `http://localhost:5173`.

---

## 🎨 Dashboard Overview

The React-based Tactical Command Console provides five operational workspaces:
1. **Live Monitor**: Visual stream layout showing YOLO detection boundaries, biometric identification labels, and real-time VLM status summaries.
2. **Alert Feed**: Graded notifications sorted by threat level.
3. **Criminal Log**: Historical roster of biometric watchlist matches.
4. **Event Log**: Master event grid supporting spreadsheet download.
5. **Agent Chat**: Conversational interface to query the security agent (Agent Nova) for forensic investigation.
