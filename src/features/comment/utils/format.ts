import { Comment } from "../types/comment";
import { THREAD_ID_PATTERN } from "./file-store";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const formatStandardComment = (comment: Comment): string => {
  return `${comment.fileName}:${comment.lineNumber + 1} ${comment.text}`;
};

export const formatOpenThreads = (
  folders: {
    name: string;
    files: {
      file: string;
      threads: { id: string; line: number; status: string; comments: { body: string }[] }[];
    }[];
  }[],
): string | undefined => {
  const lines: string[] = [];
  for (const folder of folders) {
    for (const file of folder.files) {
      for (const thread of file.threads) {
        if (thread.status !== "open" || !THREAD_ID_PATTERN.test(thread.id)) {
          continue;
        }
        const body = oneLine(thread.comments[0]?.body ?? "");
        const excerpt = body.length > 80 ? `${body.slice(0, 79)}…` : body;
        const name = oneLine(folders.length > 1 ? `${folder.name}/${file.file}` : file.file);
        lines.push(`- ${name}:${thread.line} [${thread.id}] ${excerpt}`);
      }
    }
  }
  if (!lines.length) {
    return undefined;
  }
  return `Address the ${lines.length} open review ${lines.length === 1 ? "thread" : "threads"} in .local-review/ (read .local-review/README.md first):\n${lines.join("\n")}\nReply in each thread; resolve it once the change is made.`;
};
