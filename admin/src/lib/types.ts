export type RequestStatus = "pending" | "approved" | "rejected";

export interface AdminUser {
  id: string;
  name: string | null;
  email: string;
  role: string;
  createdAt: string;
  _count: { extractions: number };
}

export interface SignupRequest {
  id: string;
  name: string;
  email: string;
  company: string | null;
  note: string | null;
  status: RequestStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedById: string | null;
  createdAt: string;
}

export interface SignupRequestsPayload {
  requests: SignupRequest[];
  counts: Record<RequestStatus, number>;
  emailConfigured: boolean;
}
