import pino from "pino";
import { env } from "../config/env.js";
import { reportLoggedError } from "../config/sentry.js";

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  hooks: {
    // error (50) and fatal (60) go to Sentry as well as the log.
    logMethod(args, method, level) {
      if (level >= 50) reportLoggedError(args[0], args[1]);
      return method.apply(this, args);
    },
  },
});
