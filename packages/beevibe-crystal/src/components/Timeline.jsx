import EventCard from "./EventCard.jsx";

export default function Timeline({ events }) {
  if (!events?.length) return <div className="cb-dim">No events.</div>;
  return (
    <div className="cb-timeline">
      {events.map((e, i) => (
        <EventCard key={i} event={e} />
      ))}
    </div>
  );
}
