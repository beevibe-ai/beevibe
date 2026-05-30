import { useEffect, useState } from "react";

const REPO_URL = "https://github.com/beevibe-ai/beevibe";
const REPO_API_URL = "https://api.github.com/repos/beevibe-ai/beevibe";

function formatStars(count) {
  if (typeof count !== "number") return "";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

export default function BeevibeAttribution({ compact = false }) {
  const [stars, setStars] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(REPO_API_URL, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const starLabel = stars == null ? "Star on GitHub" : `Star on GitHub - ${formatStars(stars)}`;

  return (
    <div className={`cb-beevibe-mark ${compact ? "cb-beevibe-mark-compact" : ""}`}>
      <span>Made with</span>
      <a href={REPO_URL} target="_blank" rel="noreferrer">Beevibe</a>
      <span aria-hidden>·</span>
      <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label={starLabel}>
        {stars == null ? "GitHub" : `★ ${formatStars(stars)}`}
      </a>
      {!compact && (
        <>
          <span aria-hidden>·</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">Publish your own</a>
        </>
      )}
    </div>
  );
}
