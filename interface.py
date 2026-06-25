from abc import ABC, abstractmethod
from typing import Optional
from eye_cursor.models import Frame

class VideoCaptureInterface(ABC):
    """Interface for camera video acquisition."""

    @abstractmethod
    def start(self) -> None:
        """Start the video capture stream, typically launching a background capture thread."""
        pass

    @abstractmethod
    def read(self) -> Optional[Frame]:
        """Read the latest captured Frame in a non-blocking manner.

        Returns:
            Frame: The latest Frame object containing image data and capture timestamp,
                   or None if no new frame is available or camera stream is closed/failed.
        """
        pass

    @abstractmethod
    def stop(self) -> None:
        """Stop the video capture stream and release all camera and thread resources."""
        pass

    @abstractmethod
    def is_running(self) -> bool:
        """Check if the video capture stream is currently running and active.

        Returns:
            bool: True if running, False otherwise.
        """
        pass

    @abstractmethod
    def get_fps(self) -> float:
        """Get the current measured Frame Rate (Frames Per Second).

        Returns:
            float: The measured FPS of the camera stream.
        """
        pass
