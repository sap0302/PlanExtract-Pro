export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body — always provided so the message survives clients that block HTML. */
  text: string;
  html: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export type SendResult = { sent: true } | { sent: false; reason: string };
