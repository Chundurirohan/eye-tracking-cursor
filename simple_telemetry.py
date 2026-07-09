import time
from typing import Any, Dict, List
from eye_cursor.telemetry.interface import TelemetryInterface

class SimpleTelemetry(TelemetryInterface):
    """In-memory telemetry logger for testing and diagnostic tracking."""

    def __init__(self) -> None:
        self.latencies: Dict[str, List[float]] = {}
        self.events: List[Dict[str, Any]] = []

    def log_latency(self, component_name: str, duration_ms: float) -> None:
        if component_name not in self.latencies:
            self.latencies[component_name] = []
        self.latencies[component_name].append(duration_ms)

    def log_event(self, event_name: str, metadata: Dict[str, Any]) -> None:
        self.events.append(
            {
                "event": event_name,
                "timestamp": time.time(),
                "metadata": metadata,
            }
        )

    def get_metrics(self) -> Dict[str, Any]:
        metrics: Dict[str, Any] = {}
        for comp, vals in self.latencies.items():
            if vals:
                metrics[f"{comp}_avg_ms"] = sum(vals) / len(vals)
                metrics[f"{comp}_count"] = len(vals)
                metrics[f"{comp}_max_ms"] = max(vals)
        metrics["event_count"] = len(self.events)
        return metrics
