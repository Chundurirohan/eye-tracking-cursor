import time
from eye_cursor.video_capture.opencv_capture import OpenCVCapture
from eye_cursor.telemetry.simple_telemetry import SimpleTelemetry

def run_video_capture_benchmark() -> None:
    """Benchmark the video capture module frame rates and latency."""
    print("Starting Video Capture Benchmark (requires camera connection or will exit)...")
    telemetry = SimpleTelemetry()
    # Use index 0 as standard default camera
    capture = OpenCVCapture(camera_index=0, telemetry=telemetry)
    
    capture.start()
    if not capture.is_running():
        print("Could not open camera index 0. Benchmark aborted.")
        return

    print("Reading frames for 2.0 seconds...")
    start_t = time.time()
    frames_read = 0
    while time.time() - start_t < 2.0:
        frame = capture.read()
        if frame is not None:
            frames_read += 1
        time.sleep(0.01)  # 100Hz read frequency
        
    capture.stop()
    
    metrics = telemetry.get_metrics()
    print("\n--- Video Capture Benchmark Results ---")
    print(f"Total read loops: {frames_read}")
    print(f"Measured Capture FPS: {capture.get_fps():.2f}")
    for k, v in metrics.items():
        print(f"Telemetry metric: {k} = {v}")

if __name__ == "__main__":
    run_video_capture_benchmark()
