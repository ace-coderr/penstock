import { log } from "@penstock/core";
import { createProxy } from "./index";

const { server, config } = createProxy();
server.listen(config.port, config.host, () => log("info", "penstock proxy listening", { host: config.host, port: config.port, mode: config.mode }));
