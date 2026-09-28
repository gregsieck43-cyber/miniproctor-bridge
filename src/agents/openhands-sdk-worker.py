"""Run one OpenHands SDK conversation as a bridge-owned JSONL process.

The SDK and LiteLLM are optional product dependencies, installed in the Python
environment named by the local OpenHands profile. Credentials come only from
the process environment. No model key or tool arguments are written to stdout.
"""

import asyncio
import json
import os
import sys
import threading
from pathlib import Path

PROTOCOL = "openhands-sdk-v1"
WIRE = sys.stdout
sys.stdout = sys.stderr  # Keep SDK banners/logging out of the JSONL channel.
os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")
_wire_lock = threading.Lock()


def emit(kind, **fields):
    with _wire_lock:
        WIRE.write(json.dumps({"protocol": PROTOCOL, "type": kind, **fields}, ensure_ascii=False) + "\n")
        WIRE.flush()


def message_text(message):
    parts = getattr(message, "content", None) or []
    return "\n".join(
        str(part.text) for part in parts
        if isinstance(getattr(part, "text", None), str)
    )


async def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        emit("error", code="prompt-required", message="OpenHands requires an initial prompt")
        return 2

    model = os.environ.get("OPENHANDS_LLM_MODEL", "").strip()
    api_key = os.environ.get("OPENHANDS_LLM_API_KEY") or os.environ.get("LLM_API_KEY")
    base_url = os.environ.get("OPENHANDS_LLM_BASE_URL", "").strip()
    if not model or not api_key:
        emit("error", code="llm-config-missing", message="Set OPENHANDS_LLM_MODEL and OPENHANDS_LLM_API_KEY in the bridge environment")
        return 2

    from pydantic import SecretStr
    from openhands.sdk import Conversation, LLM
    from openhands.sdk.conversation.state import ConversationExecutionStatus, ConversationState
    from openhands.sdk.event.conversation_error import ConversationErrorEvent
    from openhands.sdk.event.llm_convertible.action import ActionEvent
    from openhands.sdk.event.llm_convertible.message import MessageEvent
    from openhands.sdk.event.llm_convertible.observation import ObservationBaseEvent, UserRejectObservation
    from openhands.sdk.security.confirmation_policy import AlwaysConfirm
    from openhands.tools import get_default_agent
    from openhands.tools.file_editor.definition import FileEditorAction
    from openhands.tools.task_tracker.definition import TaskTrackerAction
    from openhands.tools.terminal.definition import TerminalAction

    def action_preview(action):
        details = action.action
        if isinstance(details, TerminalAction):
            # Approval must never show a truncated command: a hidden suffix could
            # change what the user actually authorizes.
            if not isinstance(details.command, str) or len(details.command) > 300:
                return None
            return {"command": details.command, "is_input": details.is_input}
        if isinstance(details, FileEditorAction):
            if not isinstance(details.path, str) or len(details.path) > 300:
                return None
            return {"operation": details.command, "path": details.path,
                    "content_hidden": True}
        if isinstance(details, TaskTrackerAction):
            return {"operation": details.command}
        return None

    def on_event(event):
        event_id = str(getattr(event, "id", ""))
        if isinstance(event, MessageEvent) and str(getattr(event, "source", "")) == "agent":
            content = message_text(event.llm_message)
            if content:
                emit("message", id=event_id, text=content[:16000])
        elif isinstance(event, ActionEvent):
            emit("action", id=event_id, tool_name=str(getattr(event, "tool_name", "unknown"))[:100])
        elif isinstance(event, ObservationBaseEvent):
            emit("observation", id=event_id, action_id=str(getattr(event, "action_id", "")),
                 tool_name=str(getattr(event, "tool_name", "unknown"))[:100],
                 denied=isinstance(event, UserRejectObservation))
        elif isinstance(event, ConversationErrorEvent):
            emit("error", code=str(getattr(event, "code", "sdk-error"))[:100],
                 message="OpenHands conversation error")

    llm_options = {"model": model, "api_key": SecretStr(api_key)}
    if base_url:
        llm_options["base_url"] = base_url
    workspace = Path.cwd()
    persistence = workspace / ".tmp" / "openhands-bridge"
    persistence.mkdir(parents=True, exist_ok=True)
    conversation = Conversation(
        agent=get_default_agent(LLM(**llm_options), cli_mode=True),
        workspace=workspace,
        persistence_dir=persistence,
        callbacks=[on_event],
        visualizer=None,
        delete_on_close=True,
    )
    conversation.set_confirmation_policy(AlwaysConfirm())
    try:
        conversation.send_message(sys.argv[1])
        emit("started")
        while True:
            await conversation.arun()
            status = conversation.state.execution_status
            if status == ConversationExecutionStatus.FINISHED:
                emit("finished")
                return 0
            if status != ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
                emit("error", code="unexpected-status", message=f"OpenHands status: {status.value}")
                return 1

            pending = ConversationState.get_unmatched_actions(conversation.state.active_branch())
            # The SDK resumes all pending actions together. Never approve a subset.
            if len(pending) != 1:
                conversation.reject_pending_actions("Multiple actions require separate approval")
                emit("error", code="approval-batch-unsupported",
                     message="OpenHands requested multiple tools in one approval batch")
                return 1
            action = pending[0]
            preview = action_preview(action)
            if preview is None:
                conversation.reject_pending_actions("Unsupported tool approval shape")
                emit("error", code="approval-preview-unavailable",
                     message="OpenHands tool arguments cannot be previewed safely")
                return 1
            request_id = str(action.id)
            emit("control_request", request_id=request_id,
                 request={"subtype": "can_use_tool", "tool_name": str(action.tool_name)[:100],
                          "input": preview})
            while True:
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line:
                    conversation.reject_pending_actions("Bridge control channel closed")
                    emit("error", code="control-channel-closed", message="Approval channel closed")
                    return 1
                try:
                    response = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (response.get("type") != "control_response"
                        or response.get("response", {}).get("request_id") != request_id):
                    continue
                behavior = response.get("response", {}).get("response", {}).get("behavior")
                if behavior == "allow":
                    break
                conversation.reject_pending_actions("Bridge denied the action")
                break
    finally:
        conversation.close()


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        emit("error", code=type(exc).__name__[:100], message="OpenHands worker failed")
        raise SystemExit(1)
