# Eye Cursor App

A production-quality Python application designed to control the operating system cursor using eye gaze from a standard webcam.

## Features & Requirements

* **Python Version**: 3.10+
* **Cross-platform**: Windows, macOS, and Linux
* **Architecture**: Fully modular and SOLID-compliant pipelines
* **Type Safety**: Strictly typed with type hints checked via `mypy`
* **Test Coverage**: Tested using `pytest`

## Project Structure

```
src/
└── eye_cursor/
    ├── models.py                   # Shared data contracts (dataclasses)
    ├── video_capture/              # Video frame acquisition (OpenCV, threaded)
    ├── face_landmark_detection/    # Facial landmarks detection
    ├── gaze_estimation/            # Eye gaze direction/vector estimation
    ├── calibration_system/         # Screen mapping and user calibration
    ├── kalman_filter/              # Signal smoothing for cursor coordinates
    ├── click_detection/            # Blink/wink/dwell gesture clicks
    ├── cursor_controller/          # OS cursor positioning and click injection
    ├── persistence_layer/          # Calibration models & settings storage
    ├── telemetry/                  # Performance loggers and statistics
    └── ui/                         # User interface for calibration and config

tests/                              # Automated test suites
docs/                               # Architectural and user documentation
```

## Installation

To set up the development environment, run:

```bash
pip install -r requirements.txt
```

To install package in editable mode:

```bash
pip install -e .
```

## Testing & Verification

Run the test suite and type checking:

```bash
# Run tests
pytest

# Type checking
mypy src
```
