import argparse
import logging
import sys
import time
from typing import Optional, Tuple

import cv2
import numpy as np

from eye_cursor.config import AppConfig
from eye_cursor.logging_setup import setup_logging
from eye_cursor.models import Frame, FaceLandmarks, RawGaze, ScreenPointRaw, ScreenPointSmooth, ClickEvent
from eye_cursor.video_capture.opencv_capture import OpenCVCapture
from eye_cursor.face_landmark_detection.mediapipe_detector import MediaPipeDetector
from eye_cursor.gaze_estimation.pytorch_estimator import PytorchL2CSNetGazeEstimator
from eye_cursor.calibration_system.calibrator import GazeCalibrator
from eye_cursor.calibration_system.ui import CalibrationUI
from eye_cursor.kalman_filter.filter import GazeKalmanFilter
from eye_cursor.click_detection.dwell_detector import GazeDwellDetector
from eye_cursor.click_detection.blink_detector import GazeBlinkDetector
from eye_cursor.cursor_controller.pyautogui_controller import CursorController
from eye_cursor.persistence_layer.json_persistence import JSONPersistence
from eye_cursor.telemetry.simple_telemetry import SimpleTelemetry

logger = logging.getLogger("eye_cursor.main")

class EyeCursorApp:
    """Core application orchestrating the entire eye cursor pipeline."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.telemetry = SimpleTelemetry()
        self.persistence = JSONPersistence()
        
        # Load configuration
        self.config = AppConfig()
        self._load_config_settings()

        # Override config settings with CLI arguments if specified
        if args.camera is not None:
            self.config.camera_index = args.camera
        if args.click_mode is not None:
            self.config.dwell_click_enabled = (args.click_mode == "dwell")
            self.config.blink_click_enabled = (args.click_mode == "blink")

        # Instantiate modules
        self.capture = OpenCVCapture(
            camera_index=self.config.camera_index,
            width=self.config.frame_width,
            height=self.config.frame_height,
            telemetry=self.telemetry,
            max_failures=self.config.camera_max_failures,
        )

        self.detector = MediaPipeDetector(
            min_detection_confidence=self.config.min_detection_confidence,
            min_tracking_confidence=self.config.min_tracking_confidence,
            telemetry=self.telemetry,
        )

        self.estimator = PytorchL2CSNetGazeEstimator(
            model_path=self.config.gaze_model_path,
            use_gpu=self.config.use_gpu,
            telemetry=self.telemetry,
        )

        self.calibrator = GazeCalibrator(
            regression_order=self.config.regression_order,
            ridge_lambda=self.config.ridge_lambda,
            edge_distortion_coef=self.config.edge_distortion_coef,
            screen_resolution=(self.args.screen_width, self.args.screen_height),
        )

        self.filter = GazeKalmanFilter(
            process_noise=self.config.kalman_process_noise,
            measurement_noise=self.config.kalman_measurement_noise,
        )

        self.dwell_detector = GazeDwellDetector(
            radius_px=self.config.dwell_radius_px,
            dwell_time_sec=self.config.dwell_time_sec,
            cooldown_sec=self.config.dwell_cooldown_sec,
        )

        self.blink_detector = GazeBlinkDetector(
            ear_threshold=self.config.blink_ear_threshold,
            double_blink_window_sec=self.config.double_blink_window_sec,
        )

        self.controller = CursorController()
        self.calibration_model: Optional[CalibrationModel] = None

    def _load_config_settings(self) -> None:
        """Load settings from persistence layer into active config."""
        saved_camera = self.persistence.get_setting("camera_index")
        if saved_camera is not None:
            self.config.camera_index = int(saved_camera)

        saved_click_mode = self.persistence.get_setting("click_mode")
        if saved_click_mode is not None:
            self.config.dwell_click_enabled = (saved_click_mode == "dwell")
            self.config.blink_click_enabled = (saved_click_mode == "blink")

    def _save_config_settings(self) -> None:
        """Save settings to persistence layer."""
        self.persistence.save_setting("camera_index", self.config.camera_index)
        click_mode = "none"
        if self.config.dwell_click_enabled:
            click_mode = "dwell"
        elif self.config.blink_click_enabled:
            click_mode = "blink"
        self.persistence.save_setting("click_mode", click_mode)

    def setup_calibration(self) -> bool:
        """Load existing calibration model or prompt user to calibrate."""
        # 1. Attempt loading existing calibration profile
        self.calibration_model = self.persistence.load_calibration("default")
        
        # 2. Trigger calibration if requested or not found
        if self.args.calibrate or self.calibration_model is None:
            logger.info("No valid calibration profile found or calibration requested. Launching UI...")
            # Start camera for calibration UI
            self.capture.start()
            time.sleep(0.5)

            calib_ui = CalibrationUI(
                capture=self.capture,
                detector=self.detector,
                estimator=self.estimator,
                screen_resolution=(self.args.screen_width, self.args.screen_height),
            )
            model = calib_ui.run_calibration()

            if model is not None:
                self.calibration_model = model
                self.persistence.save_calibration(model, "default")
                logger.info(f"Calibration successful! RMS Error: {model.rms_error:.2f}px")
                return True
            else:
                logger.error("Calibration UI was closed or aborted.")
                return False
        return True

    def run(self) -> None:
        """Execute the main processing pipeline loop."""
        logger.info("Initializing runtime pipeline...")
        self._save_config_settings()

        # Start camera capture
        if not self.capture.is_running():
            self.capture.start()

        # Warm up landmark detection
        time.sleep(0.2)
        
        # Diagnostic display window configuration
        cv2.namedWindow("Eye Cursor Diagnostics", cv2.WINDOW_NORMAL)
        cv2.resizeWindow("Eye Cursor Diagnostics", 320, 240)

        logger.info("Running. Press 'q' or 'ESC' on the diagnostic window to exit.")
        pipeline_failures = 0
        last_frame_time = time.time()

        try:
            while self.capture.is_running():
                t_loop_start = time.perf_counter()

                frame = self.capture.read()
                if frame is None:
                    pipeline_failures += 1
                    if pipeline_failures > 50:
                        logger.error("Failed to fetch frames repeatedly. Closing pipeline.")
                        break
                    time.sleep(0.01)
                    continue

                pipeline_failures = 0
                t_now = time.time()
                frame_fps = 1.0 / max(1e-5, t_now - last_frame_time)
                last_frame_time = t_now

                # Pipeline Step 1: Detect Landmarks
                landmarks = self.detector.detect(frame)
                
                # Pipeline Step 2: Handle Low-Confidence / Tracking Loss
                if (landmarks is None 
                    or landmarks.status == "lost" 
                    or landmarks.confidence < self.config.min_detection_confidence):
                    
                    self.telemetry.log_event("tracking_lost", {"confidence": getattr(landmarks, "confidence", 0.0)})
                    self.dwell_detector.reset()
                    self.blink_detector.reset()
                    # Freeze cursor, draw warning, skip processing
                    self._show_diagnostic_frame(frame, "Lost Tracking", frame_fps)
                    time.sleep(0.01)
                    continue

                # Pipeline Step 3: Gaze Estimation
                gaze = self.estimator.estimate(frame, landmarks)
                if gaze is None or gaze.confidence < self.config.gaze_confidence_threshold:
                    self.dwell_detector.reset()
                    self.blink_detector.reset()
                    self._show_diagnostic_frame(frame, "Low Gaze Confidence", frame_fps)
                    continue

                # Pipeline Step 4: Gaze to Screen Mapping
                if self.calibration_model is None:
                    # Calibration model missing, run mapping fallback
                    self._show_diagnostic_frame(frame, "Uncalibrated", frame_fps)
                    continue

                raw_point = self.calibrator.map_gaze(gaze, self.calibration_model)
                if raw_point is None:
                    continue

                # Pipeline Step 5: Kalman Smoothing
                t_filter_start = time.perf_counter()
                smooth_point = self.filter.filter(raw_point)
                self.telemetry.log_latency("kalman_filter", (time.perf_counter() - t_filter_start) * 1000.0)

                # Pipeline Step 6: Cursor Movement (Respect CLI flag)
                if not self.args.no_cursor:
                    t_controller_start = time.perf_counter()
                    self.controller.move_to(smooth_point)
                    self.telemetry.log_latency("cursor_controller", (time.perf_counter() - t_controller_start) * 1000.0)
                else:
                    logger.debug(f"Position: {smooth_point.x:.1f}, {smooth_point.y:.1f}")

                # Pipeline Step 7: Click Gesture Processing
                click_event: Optional[ClickEvent] = None
                t_click_start = time.perf_counter()

                current_pos = (smooth_point.x, smooth_point.y)

                if self.config.dwell_click_enabled:
                    click_event = self.dwell_detector.process(smooth_point)
                elif self.config.blink_click_enabled:
                    # Pass the current smoothed coordinate to populate click location
                    click_event = self.blink_detector.process(landmarks, current_pos)

                self.telemetry.log_latency("click_detection", (time.perf_counter() - t_click_start) * 1000.0)

                if click_event is not None:
                    self.telemetry.log_event("click_triggered", {"type": click_event.source})
                    if not self.args.no_cursor:
                        self.controller.trigger_click(click_event)

                # Diagnostics visualization
                self._show_diagnostic_frame(frame, "Tracking Active", frame_fps)
                
                # Check for exit key
                key = cv2.waitKey(1) & 0xFF
                if key == ord('q') or key == 27:
                    break

                # Frame limit delay if executing faster than target camera FPS
                elapsed_loop = (time.perf_counter() - t_loop_start)
                sleep_target = (1.0 / self.config.camera_fps_target) - elapsed_loop
                if sleep_target > 0:
                    time.sleep(sleep_target)

        finally:
            self.shutdown()

    def _show_diagnostic_frame(self, frame: Frame, status_text: str, current_fps: float) -> None:
        """Display raw camera feed with system diagnostics overlaid."""
        diag_img = frame.data.copy()
        h, w, _ = diag_img.shape

        # Draw overlays
        color = (0, 255, 0) if "Tracking" in status_text else (0, 0, 255)
        cv2.putText(diag_img, f"Status: {status_text}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
        cv2.putText(diag_img, f"Pipeline FPS: {current_fps:.1f}", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        cv2.putText(diag_img, f"Camera FPS: {self.capture.get_fps():.1f}", (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

        cv2.imshow("Eye Cursor Diagnostics", diag_img)

    def shutdown(self) -> None:
        """Gracefully release camera resources and close GUI windows."""
        logger.info("Shutting down Eye Cursor App...")
        self.capture.stop()
        cv2.destroyAllWindows()
        logger.info("Clean shutdown completed.")

def main() -> None:
    """CLI Entrypoint parsing arguments and starting application."""
    parser = argparse.ArgumentParser(description="Eye Cursor App - Hands-Free Gaze Cursor Controller")
    parser.add_argument("--camera", type=int, help="Override default camera device index")
    parser.add_argument("--calibrate", action="store_true", help="Forces a new calibration routine on startup")
    parser.add_argument("--click-mode", choices=["dwell", "blink", "none"], help="Override default click detection mechanism")
    parser.add_argument("--screen-width", type=int, default=1920, help="Width of the primary monitor screen in pixels")
    parser.add_argument("--screen-height", type=int, default=1080, help="Height of the primary monitor screen in pixels")
    parser.add_argument("--no-cursor", action="store_true", help="Disables actual mouse controller inputs for diagnostic modes")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging level")

    args = parser.parse_args()

    # Setup standard logging
    log_level = logging.DEBUG if args.debug else logging.INFO
    setup_logging(log_level)

    app = EyeCursorApp(args)
    
    # Run calibration system onboarding
    if not app.setup_calibration():
        sys.exit(1)

    # Run pipeline loop
    app.run()

if __name__ == "__main__":
    main()
