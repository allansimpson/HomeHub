"""The bridge may talk to one approved HomeHub and nowhere else.

``HOMEHUB_API_BASE_URL`` was any string at all, and every call sent the household's prompt and
conversation history to it. The bridge is a program on the kitchen counter with no screen, so nothing
about a wrong value is visible: it keeps working, somewhere else.

Two of these run **real listeners** rather than mocking ``requests``. The failure being tested is a
redirect being followed, and a mock of the library that follows it cannot demonstrate that the second
server did or did not receive the household's words. These ask the second server.

``unittest`` rather than pytest: the bridge has no test dependency beyond ``requests``, and adding one
to run four tests would put a package on the panel's Pi that nothing else needs.
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from homehub_voice.api import HomeHubClient, UnapprovedDestination, approve_origin  # noqa: E402


class _Config:
    """Only the fields `HomeHubClient` reads."""

    def __init__(self, base: str, approved=()):
        self.api_base_url = base
        self.allowed_origins = tuple(approved)
        self.http_timeout = 5
        self.chat_timeout = 5
        self.service_token = "test-token"


class _Listener:
    """A real HTTP server that records every body it is given."""

    def __init__(self, redirect_to: str | None = None):
        self.received: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                outer.received.append(
                    {
                        "path": self.path,
                        "body": body.decode("utf-8", "replace"),
                        "authorization": self.headers.get("Authorization"),
                    }
                )
                if redirect_to:
                    # 307 preserves the method *and* the body, which is the whole point of it.
                    self.send_response(307)
                    self.send_header("Location", redirect_to + self.path)
                    self.end_headers()
                    return
                payload = json.dumps({"text": "ok", "origin": "test"}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_port
        self.origin = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *_exc):
        self._server.shutdown()
        self._server.server_close()


class ApprovedOrigin(unittest.TestCase):
    def test_loopback_is_the_default_and_needs_no_configuration(self):
        self.assertEqual(
            approve_origin("http://localhost:5220", []), "http://localhost:5220"
        )
        self.assertEqual(
            approve_origin("http://127.0.0.1:5220", []), "http://127.0.0.1:5220"
        )

    def test_anywhere_else_needs_naming(self):
        with self.assertRaises(UnapprovedDestination):
            approve_origin("http://192.168.1.50:5220", [])
        with self.assertRaises(UnapprovedDestination):
            approve_origin("https://homehub.attacker.example", [])

    def test_an_approved_origin_is_exact(self):
        approved = ["https://homehub.house.lan:5220"]

        self.assertEqual(
            approve_origin("https://homehub.house.lan:5220", approved),
            "https://homehub.house.lan:5220",
        )
        # The listener on the next port is a different program.
        with self.assertRaises(UnapprovedDestination):
            approve_origin("https://homehub.house.lan:5221", approved)
        with self.assertRaises(UnapprovedDestination):
            approve_origin("https://homehub.house.lan", approved)

    def test_userinfo_query_and_fragment_are_refused(self):
        for url in (
            "http://user:pw@127.0.0.1:5220",
            "http://127.0.0.1:5220?to=elsewhere",
            "http://127.0.0.1:5220#elsewhere",
            "ftp://127.0.0.1:5220",
            "not-a-url",
        ):
            with self.subTest(url=url), self.assertRaises(UnapprovedDestination):
                approve_origin(url, [])

    def test_a_wrong_destination_fails_when_the_bridge_starts(self):
        # In front of whoever started it, rather than the first time somebody says the wake word.
        with self.assertRaises(UnapprovedDestination):
            HomeHubClient(_Config("http://192.168.1.50:5220"))


class Redirects(unittest.TestCase):
    """Two real listeners. The question is whether the second one hears the household."""

    def test_a_redirect_does_not_deliver_the_prompt_to_the_second_listener(self):
        with _Listener() as second:
            with _Listener(redirect_to=second.origin) as first:
                client = HomeHubClient(_Config(first.origin, [first.origin]))

                with self.assertRaises(Exception):
                    client.chat("is the back door locked", [{"role": "user", "text": "earlier"}])

                self.assertEqual(len(first.received), 1)
                # The claim is not that the credential was stripped — `requests` does that across
                # hosts anyway. It is that the household's words never arrived.
                self.assertEqual(second.received, [])

    def test_the_same_holds_for_audio(self):
        with _Listener() as second:
            with _Listener(redirect_to=second.origin) as first:
                client = HomeHubClient(_Config(first.origin, [first.origin]))

                with self.assertRaises(Exception):
                    client.transcribe(b"RIFF....WAVE-pretend-this-is-a-recording")

                self.assertEqual(second.received, [])

    def test_an_ordinary_answer_still_works(self):
        with _Listener() as only:
            client = HomeHubClient(_Config(only.origin, [only.origin]))

            result = client.chat("hello", [])

            self.assertEqual(result["text"], "ok")
            self.assertEqual(len(only.received), 1)
            self.assertEqual(only.received[0]["authorization"], "Bearer test-token")


class Proxies(unittest.TestCase):
    def test_the_session_ignores_proxy_environment_variables(self):
        """A proxy would route every call through it, and no URL check would notice.

        `requests` reads `HTTP_PROXY` and friends from the environment by default — set for a package
        install, inherited from a shell, left in a systemd unit. A bridge that talks to loopback has
        no use for one.
        """
        client = HomeHubClient(_Config("http://127.0.0.1:5220"))

        self.assertFalse(client._session.trust_env)  # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
