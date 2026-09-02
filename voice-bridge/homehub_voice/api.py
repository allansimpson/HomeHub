"""Thin client for the HomeHub API endpoints the bridge uses: STT + assistant chat."""

from __future__ import annotations

from urllib.parse import urlsplit

import requests


class UnapprovedDestination(RuntimeError):
    """The configured HomeHub origin is not one this bridge may talk to.

    Raised at construction rather than at the first call, so a misconfigured bridge fails when it is
    started — in front of whoever started it — rather than the first time somebody says the wake word
    at the kitchen counter.
    """


def approve_origin(api_base_url: str, approved: list[str]) -> str:
    """Return the origin to use, or raise :class:`UnapprovedDestination`.

    **What this closes.** ``HOMEHUB_API_BASE_URL`` was any string at all, and every call below sent
    the household's prompt and conversation history to it. The bridge is a program on the kitchen
    counter with no screen, so nothing about a wrong value is visible: it simply keeps working,
    somewhere else.

    Three separate things are checked, because the failures are different:

    * **The origin is exact** — scheme, host *and* port. A host on its own would admit the listener
      on the next port, which is a different program.
    * **The transport is loopback or TLS, with no exception.** A bridge on the same machine as
      HomeHub is the ordinary arrangement and cleartext there never touches a wire. Anywhere else it
      must be ``https``: an exact origin stops the destination being *rerouted* and authenticates
      nothing about the machine answering there, while the prompt, the conversation history and the
      recorded audio all cross the LAN in the clear. Naming a plain-http origin in the allowlist used
      to be accepted — it is not, because listing a destination is not the same as securing the path
      to it.
    * **No userinfo, query or fragment**, which have no meaning in a base URL and are the usual way a
      destination is made to read as one host while resolving at another.
    """
    parts = urlsplit(api_base_url)

    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise UnapprovedDestination(
            f"HOMEHUB_API_BASE_URL must be an absolute http(s) URL; got {api_base_url!r}."
        )
    if parts.username or parts.password:
        raise UnapprovedDestination("HOMEHUB_API_BASE_URL must not carry userinfo.")
    if parts.query or parts.fragment:
        raise UnapprovedDestination(
            "HOMEHUB_API_BASE_URL must not carry a query string or fragment."
        )

    origin = f"{parts.scheme}://{parts.hostname}:{parts.port or (443 if parts.scheme == 'https' else 80)}"

    # Loopback by literal address, not by name: `localhost` is whatever the resolver says it is, and
    # the exemption being claimed is "this never touches a wire", which is a claim about an address.
    loopback = _is_loopback_literal(parts.hostname)

    if parts.scheme != "https" and not loopback:
        raise UnapprovedDestination(
            f"{origin} is plain http to a host that is not this machine. The prompt, the conversation "
            "history and the recorded audio would cross the network in the clear, and nothing would "
            "authenticate the listener receiving them. Serve HomeHub over https with a certificate "
            "this device trusts."
        )

    if approved:
        normalised = {_normalise(a) for a in approved}
        if origin not in normalised:
            raise UnapprovedDestination(
                f"{origin} is not one of the approved HomeHub origins. Set HOMEHUB_ALLOWED_ORIGINS "
                "to the exact origin this bridge should talk to."
            )
        return origin

    # No allowlist: loopback only, which is the documented arrangement — the bridge runs on the panel.
    if not loopback:
        raise UnapprovedDestination(
            f"{origin} is not on this machine. A bridge talking to HomeHub across a network must "
            "name that exact https origin in HOMEHUB_ALLOWED_ORIGINS."
        )
    return origin


def _is_loopback_literal(hostname: str) -> bool:
    """Whether this is a loopback *address*, written as one.

    ``localhost`` is deliberately not accepted here. It is a name, and a name is a thing the resolver
    decides — ``/etc/hosts``, a search domain, a DHCP-supplied suffix. The cleartext exemption is the
    claim that the traffic never reaches a wire, so it is made about addresses rather than about a
    string that usually means one. A bridge that wants to write ``localhost`` may still do so over
    https, like any other name.
    """
    import ipaddress

    try:
        return ipaddress.ip_address(hostname.strip("[]")).is_loopback
    except ValueError:
        return False


def _normalise(origin: str) -> str:
    parts = urlsplit(origin)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return f"{parts.scheme}://{parts.hostname}:{port}"


class HomeHubClient:
    def __init__(self, cfg):  # noqa: ANN001
        # Raises before anything is sent if the destination is not one this bridge may talk to.
        self._base = approve_origin(cfg.api_base_url, getattr(cfg, "allowed_origins", []))
        self._timeout = cfg.http_timeout
        # A turn is not a short call — see Config.chat_timeout.
        self._chat_timeout = cfg.chat_timeout
        # Every HomeHub endpoint requires authentication (AUDIT A1). The bridge is a program with
        # no browser, so it presents a bearer token rather than holding a session cookie; the
        # server matches it against Auth:ServiceTokens and admits it as a *service* — able to read
        # and act on the house, and deliberately unable to reach any member's own data or the
        # household roster. Unset, every call below gets a 401, which is the correct failure for a
        # bridge nobody has issued a credential to.
        self._headers = (
            {"Authorization": f"Bearer {cfg.service_token}"} if cfg.service_token else {}
        )

        """One session, and the two properties that make it a boundary.

        ``allow_redirects=False`` on every call. A 307 or 308 preserves the method and the body, so
        an approved HomeHub answering with one would have the bridge re-post the household's prompt
        and conversation history to whatever it named. ``requests`` strips the ``Authorization``
        header across hosts, which is worth knowing and is not the protection: the private thing here
        is the body, and the body travels.

        ``trust_env = False`` because ``requests`` otherwise reads ``HTTP_PROXY`` and friends from the
        environment. A proxy variable — set for a package install, inherited from a shell, left in a
        systemd unit — would route every one of these through it, and no amount of checking the URL
        would notice. A bridge that talks to loopback has no use for a proxy at all.
        """
        self._session = requests.Session()
        self._session.trust_env = False

    def transcribe(self, wav_bytes: bytes) -> dict:
        """POST audio to the local-first STT router. Returns {"text", "engine"}."""
        resp = self._session.post(
            f"{self._base}/api/voice/transcribe",
            files={"audio": ("utterance.wav", wav_bytes, "audio/wav")},
            headers=self._headers,
            timeout=self._timeout,
            allow_redirects=False,
        )
        _refuse_redirect(resp)
        resp.raise_for_status()
        return resp.json()

    def chat(self, prompt: str, history: list[dict]) -> dict:
        """POST a turn to the assistant router. Returns {"text", "origin", "escalated", "model"}.

        `spoken` is always True from the bridge: everything here arrived through the wake word and
        leaves through Piper, so the reply is heard rather than read. The server uses it to pin the
        turn to the fast on-server model instead of the agent — a spoken answer that arrives ten
        seconds late has already failed, however good it is (ai-assistant.md, A5).
        """
        resp = self._session.post(
            f"{self._base}/api/assistant/chat",
            json={"prompt": prompt, "history": history, "force": None, "spoken": True},
            headers=self._headers,
            # The turn ceiling, not the short one. Hanging up on a slow answer is the one failure
            # nobody here can see coming: there is no screen in the kitchen showing that it was still
            # being written.
            timeout=self._chat_timeout,
            allow_redirects=False,
        )
        _refuse_redirect(resp)
        resp.raise_for_status()
        return resp.json()

    def speak(self, text: str, prosody: str = "warm") -> bytes | None:
        """Synthesize in the app's central voice. Returns WAV bytes, or None when the server has
        no TTS configured (501) so the caller can use its local voice instead."""
        resp = self._session.post(
            f"{self._base}/api/voice/speak",
            json={"text": text, "prosody": prosody, "allowCache": True},
            headers=self._headers,
            timeout=self._timeout,
            allow_redirects=False,
        )
        _refuse_redirect(resp)
        if resp.status_code == 501:
            return None
        resp.raise_for_status()
        return resp.content


def _refuse_redirect(resp: requests.Response) -> None:
    """Turn a 3xx into a failure rather than letting it read as an answer.

    ``allow_redirects=False`` stops the second request being made, and leaves a 3xx sitting in the
    response where ``raise_for_status`` would let it pass as success. Said out loud instead: an
    approved HomeHub origin that starts answering with redirects is a situation somebody should hear
    about, not one the bridge should quietly treat as a failed turn.
    """
    if 300 <= resp.status_code < 400:
        raise requests.RequestException(
            f"HomeHub answered {resp.status_code} redirecting to "
            f"{resp.headers.get('Location', 'an unnamed destination')}; the bridge does not follow "
            "redirects, because the body it would re-send is the household's own words."
        )
