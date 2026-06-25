import json
import logging
import os
from typing import Any, Dict, Optional, Tuple
from eye_cursor.models import CalibrationModel
from eye_cursor.persistence_layer.interface import PersistenceInterface

logger = logging.getLogger(__name__)

class JSONPersistence(PersistenceInterface):
    """File persistence layer using JSON serialization, supporting backups and migrations."""

    CURRENT_VERSION = "1.0.0"

    def __init__(self, base_dir: str = ".") -> None:
        self._base_dir = base_dir
        self._settings_path = os.path.join(base_dir, "settings.json")
        self._calibration_path = os.path.join(base_dir, "calibration_profiles.json")

    def _safe_write(self, filepath: str, data: Dict[str, Any]) -> bool:
        """Write JSON data to a temp file first, then rename to prevent write-corruption."""
        tmp_filepath = filepath + ".tmp"
        try:
            # Add versioning info
            data["_version"] = self.CURRENT_VERSION

            with open(tmp_filepath, "w") as f:
                json.dump(data, f, indent=4)

            # Atomic replace
            if os.path.exists(filepath):
                os.remove(filepath)
            os.rename(tmp_filepath, filepath)
            return True
        except Exception as e:
            logger.error(f"Failed to write persisted file {filepath}: {e}")
            if os.path.exists(tmp_filepath):
                try:
                    os.remove(tmp_filepath)
                except Exception:
                    pass
            return False

    def _safe_read(self, filepath: str) -> Optional[Dict[str, Any]]:
        """Read JSON data from file, falling back to backup if corrupted."""
        if not os.path.exists(filepath):
            return None

        try:
            with open(filepath, "r") as f:
                data = json.load(f)
            return self._migrate(data)
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"File {filepath} corrupted: {e}. Attempting recovery from backup...")
            # Attempt recovery if a temp/backup file exists
            tmp_path = filepath + ".tmp"
            if os.path.exists(tmp_path):
                try:
                    with open(tmp_path, "r") as f:
                        data = json.load(f)
                    logger.info(f"Successfully recovered {filepath} from temp backup.")
                    return self._migrate(data)
                except Exception as ex:
                    logger.error(f"Backup file also corrupted: {ex}")
            return None

    def _migrate(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Perform schema migrations based on version key."""
        version = data.get("_version", "0.0.0")
        if version == self.CURRENT_VERSION:
            return data

        # Implementation of schema migration steps can go here
        logger.info(f"Migrating settings schema from {version} to {self.CURRENT_VERSION}...")
        data["_version"] = self.CURRENT_VERSION
        return data

    def save_calibration(self, model: CalibrationModel, profile_name: str) -> bool:
        """Persist CalibrationModel parameters."""
        profiles = self._safe_read(self._calibration_path) or {}
        
        # Serialize the dataclass to dictionary
        model_dict = {
            "coefficients": model.coefficients,
            "rms_error": model.rms_error,
            "screen_resolution": list(model.screen_resolution),
            "calibration_timestamp": model.calibration_timestamp,
        }

        profiles[profile_name] = model_dict
        success = self._safe_write(self._calibration_path, profiles)
        if success:
            logger.info(f"Saved calibration profile '{profile_name}'.")
        return success

    def load_calibration(self, profile_name: str) -> Optional[CalibrationModel]:
        """Retrieve persisted CalibrationModel parameters."""
        profiles = self._safe_read(self._calibration_path)
        if not profiles or profile_name not in profiles:
            logger.warning(f"Calibration profile '{profile_name}' not found.")
            return None

        try:
            p_data = profiles[profile_name]
            # Handle resolution conversion (list to tuple)
            res = tuple(p_data["screen_resolution"])
            # Ensure type safety matching Tuple[int, int]
            screen_res = (int(res[0]), int(res[1]))

            return CalibrationModel(
                coefficients=p_data["coefficients"],
                rms_error=p_data["rms_error"],
                screen_resolution=screen_res,
                calibration_timestamp=p_data["calibration_timestamp"],
            )
        except KeyError as e:
            logger.error(f"Corrupted calibration profile structure: key {e} missing.")
            return None

    def save_setting(self, key: str, value: Any) -> bool:
        """Save a system setting key/value pair."""
        settings = self._safe_read(self._settings_path) or {}
        settings[key] = value
        return self._safe_write(self._settings_path, settings)

    def get_setting(self, key: str, default: Optional[Any] = None) -> Any:
        """Retrieve a system setting key/value pair."""
        settings = self._safe_read(self._settings_path)
        if not settings or key not in settings:
            return default
        return settings[key]
