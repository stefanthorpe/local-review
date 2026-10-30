import type { CommentProvider } from "../utils/provider";

export interface CommentContext {
  commentProvider: CommentProvider;
  copyToClipboard: (text: string) => Promise<boolean>;
}

export type CommentAction = (ctx: CommentContext) => Promise<void>;
