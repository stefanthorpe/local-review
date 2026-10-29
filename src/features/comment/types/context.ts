import type { CommentProvider } from "../utils/provider";
import type { CommentInputResult } from "../utils/input";

export interface CommentContext {
  commentProvider: CommentProvider;
  showCommentInput: () => Promise<CommentInputResult | undefined>;
  copyToClipboard: (text: string) => Promise<boolean>;
}

export type CommentAction = (ctx: CommentContext) => Promise<void>;
