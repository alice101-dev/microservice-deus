import { profileLookup } from "@deus/clients";
import { createClient } from "@deus/http";
import { createRelay } from "@deus/outbox";
import { startService } from "@deus/runtime";
import { Type } from "@sinclair/typebox";
import nodemailer from "nodemailer";
import { createApp } from "./app";
import { deliveryHandlers } from "./delivery";
import { schema } from "./schema";

startService({
  config: {
    ORGANIZATION_URL: Type.String({ default: "http://organization" }),
    UPSTREAM_TIMEOUT_MS: Type.Integer({ default: 5000 }),
    SMTP_HOST: Type.String({ default: "mailpit-smtp.mailpit.svc.cluster.local." }),
    SMTP_PORT: Type.Integer({ default: 25 }),
    SMTP_SECURE: Type.Boolean({ default: false }),
    SMTP_USER: Type.String({ default: "" }),
    SMTP_PASSWORD: Type.String({ default: "" }),
    MAIL_FROM: Type.String({ default: "Deus <no-reply@deus.example>" }),
  },
  schema,
  build: (context) => {
    const { config } = context;
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const relay = createRelay({
      db: context.db,
      logger: context.logger,
      handlers: deliveryHandlers({
        db: context.db,
        logger: context.logger,
        profile: profileLookup(
          createClient({
            name: "organization",
            baseUrl: config.ORGANIZATION_URL,
            timeoutMs: config.UPSTREAM_TIMEOUT_MS,
          }),
          context.serviceToken,
        ),
        send: async (mail) => {
          const info = await transport.sendMail({
            from: config.MAIL_FROM,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            attachments: mail.attachments.map((attachment) => ({
              ...attachment,
              content: Buffer.from(attachment.content),
            })),
          });
          return { messageId: info.messageId };
        },
      }),
    });
    relay.start();
    context.onShutdown(async () => {
      await relay.stop();
      transport.close();
    });
    return createApp(context);
  },
});
