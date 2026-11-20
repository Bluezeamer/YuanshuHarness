// 设备的底层连接登记：撤销时掐断、自己关了不残留、重复登记不重复挂监听。
import net from "node:net";
import { expect, test } from "vitest";
import { DeviceConnections } from "./connections.js";

/** 起一个本地服务端与一个客户端连接，返回两端的 socket。 */
const pair = async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  const accepted = new Promise<net.Socket>((r) => server.once("connection", r));
  const client = net.connect(port, "127.0.0.1");
  await new Promise<void>((r) => client.once("connect", r));
  const socket = await accepted;
  const closed = (s: net.Socket) =>
    new Promise<void>((r) => s.once("close", () => r()));
  const done = async () => {
    client.destroy();
    socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { client, socket, closed, done };
};

test("track 之后 disconnect 把连接掐断，并返回掐断的数量", async () => {
  const { client, socket, closed, done } = await pair();
  const connections = new DeviceConnections();
  connections.track("d1", socket);
  const shut = closed(socket);
  expect(connections.disconnect("d1")).toBe(1);
  await shut;
  expect(client.destroyed || socket.destroyed).toBe(true);
  // 已经清空，再撤一次没有可掐的
  expect(connections.disconnect("d1")).toBe(0);
  await done();
});

test("连接自己关了之后不残留，disconnect 不报错", async () => {
  const { socket, closed, done } = await pair();
  const connections = new DeviceConnections();
  connections.track("d1", socket);
  const shut = closed(socket);
  socket.destroy();
  await shut;
  // close 监听是异步的，等一拍
  await new Promise((r) => setImmediate(r));
  expect(connections.disconnect("d1")).toBe(0);
  await done();
});

test("同一个 socket 重复 track 只登记一次，disconnect 只算一个", async () => {
  const { socket, closed, done } = await pair();
  const connections = new DeviceConnections();
  connections.track("d1", socket);
  connections.track("d1", socket);
  const shut = closed(socket);
  expect(connections.disconnect("d1")).toBe(1);
  await shut;
  await done();
});
