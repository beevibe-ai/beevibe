import { textOfContent } from "../lib/schema.js";

function MessageCard({ event }) {
  const isUser = event.role === "user";
  const text = textOfContent(event.content);
  return (
    <div className={`cb-event cb-message ${isUser ? "cb-user" : "cb-assistant"}`}>
      <div className="cb-role">{isUser ? "user" : "assistant"}</div>
      <div className="cb-text">{text || <em className="cb-dim">(no text)</em>}</div>
    </div>
  );
}

function ToolUseCard({ event }) {
  const okClass =
    event.ok === true ? "cb-ok" : event.ok === false ? "cb-fail" : "cb-pending";
  return (
    <div className={`cb-event cb-tool ${okClass}`}>
      <div className="cb-role">
        tool · <strong>{event.name}</strong>
        {event.ok === false && <span className="cb-tag-fail">failed</span>}
      </div>
      {event.input && Object.keys(event.input).length > 0 && (
        <pre className="cb-pre">
          {JSON.stringify(event.input, null, 2).slice(0, 600)}
        </pre>
      )}
      {event.result && (
        <pre className="cb-pre cb-result">{String(event.result).slice(0, 800)}</pre>
      )}
    </div>
  );
}

function FileChangeCard({ event }) {
  return (
    <div className="cb-event cb-file">
      <div className="cb-role">
        file · <strong>{event.path}</strong>
      </div>
      {event.diff && <pre className="cb-pre cb-diff">{event.diff.slice(0, 1200)}</pre>}
    </div>
  );
}

function ThinkingCard({ event }) {
  return (
    <div className="cb-event cb-thinking">
      <div className="cb-role">thinking</div>
      <div className="cb-text cb-dim">{event.content}</div>
    </div>
  );
}

export default function EventCard({ event }) {
  switch (event.type) {
    case "message":
      return <MessageCard event={event} />;
    case "tool_use":
      return <ToolUseCard event={event} />;
    case "file_change":
      return <FileChangeCard event={event} />;
    case "thinking":
      return <ThinkingCard event={event} />;
    default:
      return null;
  }
}
