import type { Address } from "@solana/kit";

import type { MintInfo, SessionView, VaultView } from "./chain";
import type { Notice } from "./components/ui";
import { chainNow } from "./format";
import type { Identity } from "./identity";

export type View = "overview" | "sessions" | "keys" | "playground";

export type AppData = {
  identity: Identity;
  mint: MintInfo;
  vault: VaultView;
  sessions: SessionView[];
  relayer: Address | null;
  refresh: () => Promise<void>;
  notify: (notice: Notice) => void;
  go: (view: View) => void;
};

export const isActive = (session: SessionView) => Number(session.data.expiresAt) > chainNow();
