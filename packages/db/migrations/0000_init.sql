-- ALG initial schema (M0)
--
-- Deliberately NO row level security anywhere. Supabase is used as a plain
-- Postgres instance; the frontend never connects to it. Tenant isolation lives in
-- the API layer via withWorkspace(). Adding RLS policies here would give a false
-- sense of safety and conflict with the service-role connection the API uses.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" varchar(64) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "display_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" varchar(16) DEFAULT 'member' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "target_type" varchar(32) NOT NULL,
  "name" text NOT NULL,
  "domain" text,
  "website" text,
  "phone" text,
  "email" text,
  "street" text,
  "house_number" text,
  "postal_code" varchar(16),
  "city" text,
  "region" text,
  "country_code" varchar(2),
  "lat" double precision,
  "lon" double precision,
  "name_normalized" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "company_id" uuid REFERENCES "companies"("id") ON DELETE CASCADE,
  "first_name" text,
  "last_name" text,
  "role" text,
  "email" text,
  "phone" text,
  "linkedin_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "source_id" varchar(64) NOT NULL,
  "external_id" text,
  "source_url" text,
  "raw_payload" jsonb,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "kind" varchar(32) NOT NULL,
  "relative_path" text NOT NULL,
  "mime" varchar(128) NOT NULL,
  "size_bytes" bigint NOT NULL,
  "checksum" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "actor_user_id" uuid,
  "action" varchar(64) NOT NULL,
  "resource_type" varchar(64) NOT NULL,
  "resource_id" uuid,
  "metadata" jsonb,
  "ip_address" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" varchar(255) NOT NULL,
  "request_fingerprint" varchar(64) NOT NULL,
  "response_status" jsonb,
  "response_body" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_key" ON "workspaces" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_user_key" ON "workspace_members" ("workspace_id","user_id");
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" ("user_id");

CREATE INDEX IF NOT EXISTS "companies_workspace_idx" ON "companies" ("workspace_id");
CREATE INDEX IF NOT EXISTS "companies_workspace_target_idx" ON "companies" ("workspace_id","target_type");
CREATE UNIQUE INDEX IF NOT EXISTS "companies_workspace_domain_key" ON "companies" ("workspace_id","domain") WHERE "domain" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "companies_workspace_postal_idx" ON "companies" ("workspace_id","postal_code");
CREATE INDEX IF NOT EXISTS "companies_workspace_created_idx" ON "companies" ("workspace_id","created_at","id");
-- Trigram index backs the fuzzy dedupe stage (name + postal code, threshold 0.85).
CREATE INDEX IF NOT EXISTS "companies_name_trgm_idx" ON "companies" USING gin ("name_normalized" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "contacts_workspace_idx" ON "contacts" ("workspace_id");
CREATE INDEX IF NOT EXISTS "contacts_workspace_company_idx" ON "contacts" ("workspace_id","company_id");
CREATE INDEX IF NOT EXISTS "contacts_workspace_email_idx" ON "contacts" ("workspace_id","email");
CREATE INDEX IF NOT EXISTS "contacts_workspace_created_idx" ON "contacts" ("workspace_id","created_at","id");

CREATE INDEX IF NOT EXISTS "company_sources_workspace_idx" ON "company_sources" ("workspace_id");
CREATE INDEX IF NOT EXISTS "company_sources_company_idx" ON "company_sources" ("workspace_id","company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_sources_workspace_source_external_key" ON "company_sources" ("workspace_id","source_id","external_id");

CREATE INDEX IF NOT EXISTS "files_workspace_idx" ON "files" ("workspace_id");
CREATE INDEX IF NOT EXISTS "files_workspace_kind_idx" ON "files" ("workspace_id","kind");
CREATE INDEX IF NOT EXISTS "files_expires_idx" ON "files" ("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "files_relative_path_key" ON "files" ("relative_path");

CREATE INDEX IF NOT EXISTS "audit_log_workspace_idx" ON "audit_log" ("workspace_id");
CREATE INDEX IF NOT EXISTS "audit_log_workspace_created_idx" ON "audit_log" ("workspace_id","created_at");
CREATE INDEX IF NOT EXISTS "audit_log_workspace_action_idx" ON "audit_log" ("workspace_id","action");

CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_workspace_key_key" ON "idempotency_keys" ("workspace_id","key");
CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_idx" ON "idempotency_keys" ("expires_at");
