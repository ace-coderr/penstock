import { log } from "@penstock/core";
import { createProxy } from "./index";

const { server, config } = createProxy();
server.listen(config.port, () => log("info", "penstock proxy listening", { port: config.port, mode: config.mode }));
