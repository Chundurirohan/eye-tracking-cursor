import logging
import sys
from abc import ABC, abstractmethod
from typing import Tuple, Optional

try:
    import pyautogui
    # Remove default PyAutoGUI pauses for instantaneous movements
    pyautogui.PAUSE = 0.0
    pyautogui.FAILSAFE = False
except ImportError:
    pyautogui = None

from eye_cursor.models import ScreenPointSmooth, ClickEvent
from eye_cursor.cursor_controller.interface import CursorControllerInterface

logger = logging.getLogger(__name__)


class CursorBackend(ABC):
    """Low-level OS cursor control backend interface."""

    @abstractmethod
    def move_cursor(self, x: float, y: float) -> None:
        """Physically move OS mouse cursor."""
        pass

    @abstractmethod
    def left_click(self) -> None:
        """Inject OS mouse left click."""
        pass

    @abstractmethod
    def right_click(self) -> None:
        """Inject OS mouse right click."""
        pass

    @abstractmethod
    def get_position(self) -> Tuple[int, int]:
        """Query physical OS cursor position."""
        pass


class PyAutoGUIBackend(CursorBackend):
    """OS cursor control implementation using PyAutoGUI."""

    def __init__(self) -> None:
        if pyautogui is None:
            logger.warning("PyAutoGUI is not installed. Mouse controller will run in simulation mode.")

        # Configure High-DPI screen scaling awareness on Windows
        if sys.platform == "win32":
            try:
                import ctypes
                # Set DPI awareness to Per-Monitor V2 (val=2) or standard System aware (val=1)
                ctypes.windll.shcore.SetProcessDpiAwareness(2)
                logger.info("Windows Process DPI Awareness set to Per-Monitor Aware.")
            except Exception as e:
                logger.warning(f"Failed configuring Windows DPI awareness: {e}")

    def move_cursor(self, x: float, y: float) -> None:
        if pyautogui is not None:
            try:
                pyautogui.moveTo(int(x), int(y))
            except Exception as e:
                logger.error(f"Failed to move cursor via PyAutoGUI: {e}")
        else:
            logger.debug(f"Simulated cursor move to: ({x}, {y})")

    def left_click(self) -> None:
        if pyautogui is not None:
            try:
                pyautogui.click()
            except Exception as e:
                logger.error(f"Failed to trigger left click via PyAutoGUI: {e}")
        else:
            logger.info("Simulated left mouse click")

    def right_click(self) -> None:
        if pyautogui is not None:
            try:
                pyautogui.rightClick()
            except Exception as e:
                logger.error(f"Failed to trigger right click via PyAutoGUI: {e}")
        else:
            logger.info("Simulated right mouse click")

    def get_position(self) -> Tuple[int, int]:
        if pyautogui is not None:
            try:
                cx, cy = pyautogui.position()
                return int(cx), int(cy)
            except Exception as e:
                logger.error(f"Failed to query mouse position: {e}")
                return 0, 0
        else:
            return 0, 0


class CursorController(CursorControllerInterface):
    """High-level cursor mapping and gesture action injector."""

    def __init__(self, backend: Optional[CursorBackend] = None) -> None:
        # Defaults to PyAutoGUI backend
        self.backend = backend or PyAutoGUIBackend()

    def move_to(self, point: ScreenPointSmooth) -> None:
        """Map and move the cursor to a smoothed coordinate."""
        self.backend.move_cursor(point.x, point.y)

    def trigger_click(self, event: ClickEvent) -> None:
        """Inject OS click event based on click target trigger."""
        if event.button == "left":
            self.backend.left_click()
        elif event.button == "right":
            self.backend.right_click()
        else:
            logger.warning(f"Unrecognized mouse button target: {event.button}")

    def get_position(self) -> Tuple[int, int]:
        """Fetch current mouse position coordinates."""
        return self.backend.get_position()
