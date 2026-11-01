import { createUpstreamServer } from "./index";

const port = Number(process.env.UPSTREAM_PORT ?? 4030);
createUpstreamServer().listen(port, "127.0.0.1", () => {
  console.log(`example upstream APIs on http://127.0.0.1:${port}`);
});
