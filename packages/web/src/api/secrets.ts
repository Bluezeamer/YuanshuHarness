import { call } from "./http";

export interface SecretInfo {
  id: string;
  name: string;
  kind: string;
}

export const listSecrets = (token: string | null) =>
  call(
    "GET",
    "/api/v1/secrets",
    token,
    undefined,
    (b: { secrets: SecretInfo[] }) => {
      if (!Array.isArray(b.secrets)) throw new Error("shape");
      return b.secrets;
    },
  );
