import { startService } from "@deus/runtime";
import { createApp } from "./app";
import { schema } from "./schema";

startService({ config: {}, schema, build: createApp });
