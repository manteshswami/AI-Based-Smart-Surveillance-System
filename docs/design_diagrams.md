# WatchAI — Database Schemas & System Flow Diagrams

This document contains the Entity-Relationship (ER) database schema and UML class & sequence diagrams for the WatchAI surveillance platform.

---

## 1. Entity-Relationship (ER) Diagram

This diagram displays the relational SQLite layer and the ChromaDB vector database index.

```mermaid
erDiagram
    %% SQLite Relational Layer
    FRAMES {
        int id PK "AUTOINCREMENT"
        int frame_id "Frame index counter"
        string timestamp "ISO8601 Timestamp"
        string location "Physical Camera Spot"
        string camera_id "e.g., CAM-01-FACE"
        string objects_json "JSON serialized object list"
        string detections_json "JSON coordinate boxes"
        string vlm_description "Natural language VLM output"
        string threat_level "LOW | MEDIUM | HIGH"
        string criminal_name "Suspect name (null if unknown)"
        int risk_score "Computed score [0-100]"
        string risk_level "LOW | MEDIUM | HIGH | CRITICAL"
        int alert_triggered "Boolean (0 | 1)"
        string frame_path "Local JPEG crop filesystem path"
        string created_at "SQLite insertion time"
    }

    ALERTS {
        int id PK "AUTOINCREMENT"
        int frame_id FK "References FRAMES(frame_id)"
        string timestamp "ISO8601 Timestamp"
        string location "Physical Camera Spot"
        string camera_id "e.g., CAM-01-FACE"
        string rule_name "Triggered rule identifier"
        string alert_text "Summarized warning description"
        string severity "HIGH | CRITICAL | MEDIUM"
        string criminal "Matched suspect name"
        string created_at "SQLite insertion time"
    }

    %% ChromaDB Semantic Layer
    CHROMADB_COLLECTION_WATCHAI_EVENTS {
        string id PK "Matches FRAMES.frame_id"
        vector embedding "768-d nomic-embed-text vector"
        string document "Stores FRAMES.vlm_description"
        json metadata "Filters: location, timestamp, threat_level, criminal_name"
    }

    %% Relationships
    FRAMES ||--o{ ALERTS : "triggers"
    FRAMES ||--|| CHROMADB_COLLECTION_WATCHAI_EVENTS : "indexes semantically"
```

---

## 2. UML Class Diagram

This diagram shows the structural classes of the backend engine, showing the modular architecture from ingestion down to agent execution.

```mermaid
classDiagram
    class Config {
        +string SQLITE_DB_PATH
        +string CHROMA_PERSIST_DIR
        +float FACE_MATCH_THRESHOLD
        +int VLM_FRAME_BUFFER
        +float VLM_CALL_INTERVAL_SECONDS
    }

    class FrameIndexer {
        -string db_path
        -PersistentClient chroma_client
        -Collection chroma_collection
        +init_db()
        +add_frame(frame_data)
        +add_alert(alert_data)
        +query_by_criminal(name)
        +get_all_alerts(severity, criminal)
        +semantic_search(query_text, limit)
    }

    class YOLODetector {
        -YOLO model
        +detect(frame) list
        +person_boxes(detections) list
    }

    class FaceRecognizer {
        +recognize_faces_in_frame(frame_rgb, known_encodings, known_names) list
    }

    class VLMAnalyzer {
        -string api_key
        -deque frame_buffer
        +score_frame(frame, detections) float
        +buffer_frame(frame, detections)
        +analyze(frame, criminal_context) VLMResult
    }

    class AlertEngine {
        -list rules
        +evaluate_rules(event, cross_cam_state) list
    }

    class SecurityAgent {
        -MemorySaver checkpointer
        +build_agent() CompiledGraph
        +summarize_today() string
        +semantic_search(query) string
        +query_criminal_alerts(name) string
        +get_risk_breakdown(name) string
    }

    %% Associations
    FrameIndexer ..> Config : read
    YOLODetector ..> Config : read
    VLMAnalyzer ..> Config : read
    SecurityAgent --> FrameIndexer : queries
    AlertEngine --> FrameIndexer : inserts alerts
```

---

## 3. UML Sequence Diagram

This details the sequential message-passing and thread execution flow during real-time multi-camera processing.

```mermaid
sequenceDiagram
    autonumber
    actor Operator as Security Operator
    participant UI as React Command UI
    participant Server as FastAPI Server
    participant C1 as Camera 1 Thread (Face Cam)
    participant Cache as Shared Cache (30s TTL)
    participant C2 as Camera 2 Thread (Scene Cam)
    participant VLM as Gemini VLM API
    participant DB as FrameIndexer (SQLite + Chroma)

    Operator->>UI: Click "Engage" (Start Live Monitoring)
    UI->>Server: POST /control (action="start", role="face")
    Server->>Server: Spin up C1 and C2 background threads
    
    par Camera 1 (Biometrics Loop)
        rect rgb(40, 50, 40)
            C1->>C1: Capture BGR Frame & run MOG2 motion gate
            C1->>C1: Run YOLOv8 detection and crop faces
            C1->>C1: Compute Euclidean distance against Encodings
            alt Match <= 0.55 (Suspect Identified)
                C1->>Cache: _set_criminal_context(Suspect Profile)
            end
            C1->>DB: add_frame(biometric event metadata)
            C1->>Server: Push event packet to WebSocket queue
        end
    and Camera 2 (Situational Loop)
        rect rgb(50, 40, 40)
            C2->>C2: Capture BGR Frame & run MOG2 motion gate
            C2->>C2: Run YOLOv8 detection
            C2->>Cache: _get_criminal_context()
            Cache-->>C2: Return context (if <30s old)
            C2->>C2: Add frame to Top-N buffer (Score quality)
            alt Buffer Full (10 frames accumulated)
                C2->>VLM: Send highest-scoring frame + enriched prompt
                VLM-->>C2: Return Threat level & Description
            end
            C2->>DB: add_frame(VLM report & threat level)
            C2->>Server: Push event packet to WebSocket queue
        end
    end

    Server-->>UI: Broadcast base64 annotated JPEGs + JSON metadata
    UI->>Operator: Update live camera hud, lists, and fire severity alerts
```
