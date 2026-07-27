import { Github } from "lucide-react";

export const GITHUB_REPO_URL = "https://github.com/wassgha/rescript";

/** Compact link to the public repo — icon for the editor bar, labeled for the upload footer. */
export default function GitHubLink({
  variant = "icon",
}: {
  variant?: "icon" | "text";
}) {
  if (variant === "text") {
    return (
      <a
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-zinc-400 transition hover:text-zinc-600"
      >
        <Github size={12} aria-hidden />
        GitHub
      </a>
    );
  }

  return (
    <a
      href={GITHUB_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="GitHub"
      aria-label="GitHub repository"
      className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800"
    >
      <Github size={16} aria-hidden />
    </a>
  );
}
