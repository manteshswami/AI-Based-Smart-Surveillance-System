import sys
import os
from pathlib import Path

# Add project root to path
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

import queue
import cv2
import api.server as server

def test_batch():
    video_path = str(ROOT / "app_uploaded_temp.mp4")
    if not os.path.exists(video_path):
        print(f"Test video {video_path} not found. Skipping physical scan test.")
        return

    print(f"Found test video {video_path}. Starting dry run batch analysis...")

    # Mock the frame queue so we can read from it
    server._frame_queue = queue.Queue()

    # Call worker directly
    server._batch_analyze_worker(
        source=video_path,
        location="Zone B - Street Junction",
        camera_role="both",
        camera_id="BATCH-TEST"
    )

    print("\n--- Reading queued WebSocket messages ---")
    progress_count = 0
    complete_received = False
    events_found = 0

    while not server._frame_queue.empty():
        msg = server._frame_queue.get()
        msg_type = msg.get("type")
        if msg_type == "batch_progress":
            progress_count += 1
            if progress_count % 10 == 0 or msg["percent"] == 100:
                print(f"Progress update: {msg['percent']}% - {msg['phase']}")
        elif msg_type == "batch_complete":
            complete_received = True
            events_found = len(msg.get("events", []))
            print(f"🎉 Batch complete event received! Filename: {msg.get('filename')}")
            print(f"Total peak events processed: {events_found}")
        elif msg_type == "batch_error":
            print(f"❌ Error occurred: {msg.get('message')}")

    assert complete_received, "Failed to receive batch complete event."
    print("✅ Fast-batch video analysis dry run completed successfully!")

if __name__ == "__main__":
    test_batch()
