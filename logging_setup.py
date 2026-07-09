import logging
import sys

def setup_logging(level: int = logging.INFO) -> None:
    """Configure structured logging format for console."""
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Prevent duplicate handlers if called multiple times
    if root_logger.handlers:
        return

    log_format = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    formatter = logging.Formatter(log_format)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    logging.info("Logging initialized successfully.")
