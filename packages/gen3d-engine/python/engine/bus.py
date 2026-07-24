"""Fan-out event bus for the /events NDJSON stream."""

from __future__ import annotations

import queue
import threading
import time


class EventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue] = []

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=1000)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def publish(self, event: dict) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass  # slow reader: drop rather than block the engine

    def keepalive_loop(self) -> None:
        while True:
            time.sleep(15)
            self.publish({"type": "keepalive"})
