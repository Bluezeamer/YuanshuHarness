import { call } from "./http";

export interface EnvironmentInfo {
  id: string;
  name: string;
  kind: "local" | "ssh";
}

export const listEnvironments = (token: string | null) =>
  call(
    "GET",
    "/api/v1/environments",
    token,
    undefined,
    (b: { environments: EnvironmentInfo[] }) => {
      if (!Array.isArray(b.environments)) throw new Error("shape");
      return b.environments;
    },
  );
