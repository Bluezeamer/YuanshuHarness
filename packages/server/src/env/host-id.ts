// 主机标识（IMPLEMENTATION §5.1）与现有环境 id 的最小映射。Q7（本机是否等同 server、能否当 ssh 目标）未决，
// 这里只做可替换的别名：对外的 `server` 就是 Server 所在主机，对内仍是环境 id `local`（GET /connections 的 server 字段给出对应）。
// 其余主机标识就是连接 id，与环境 id 一致，不改既有环境 id 体系。
export const SERVER_HOST_ID = "server";
