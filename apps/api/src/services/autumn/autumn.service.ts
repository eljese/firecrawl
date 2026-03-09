import { logger } from "../../lib/logger";
import { getACUCTeam } from "../../controllers/auth";
import { RateLimiterMode } from "../../types";
import { supabase_rr_service } from "../supabase";
import { autumnClient } from "./client";
import type {
  CreateEntityParams,
  EnsureOrgProvisionedParams,
  EnsureTeamProvisionedParams,
  GetEntityParams,
  GetOrCreateCustomerParams,
  TrackCreditsParams,
  TrackParams,
} from "./types";

const CREDITS_FEATURE_ID = "CREDITS";

const AUTUMN_DEFAULT_PLAN_ID = "free";
const AUTUMN_PROVISIONING_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * Wraps Autumn customer/entity provisioning and usage tracking for team credit billing.
 */
class AutumnService {
  private customerOrgCache = new Map<string, string>();
  private ensuredOrgs = new Set<string>();
  private ensuredTeams = new Set<string>();
  private backfillRunning = false;
  /** Serialises concurrent backfills per team (see backfillUsageIfNeeded). */
  private backfillQueue = new Map<string, Promise<void>>();

  private isPreviewTeam(teamId: string): boolean {
    return teamId === "preview" || teamId.startsWith("preview_");
  }

  private async lookupOrgIdForTeam(teamId: string): Promise<string> {
    const { data, error } = await supabase_rr_service
      .from("teams")
      .select("org_id")
      .eq("id", teamId)
      .single();

    if (error) throw error;
    if (!data?.org_id) {
      throw new Error(`Missing org_id for team ${teamId}`);
    }

    return data.org_id;
  }

  private getErrorStatus(error: unknown): number | undefined {
    const status = (error as any)?.statusCode ?? (error as any)?.status;
    if (typeof status === "number") return status;
    const responseStatus = (error as any)?.response?.status;
    return typeof responseStatus === "number" ? responseStatus : undefined;
  }

  private async getOrCreateCustomer({
    customerId,
    name,
    email,
    autoEnablePlanId = AUTUMN_DEFAULT_PLAN_ID,
  }: GetOrCreateCustomerParams): Promise<unknown | null> {
    if (!autumnClient) return null;
    if (!customerId) return null;

    try {
      const customer = await autumnClient.customers.getOrCreate({
        customerId,
        name: name ?? undefined,
        email: email ?? undefined,
        autoEnablePlanId,
      });
      logger.info("Autumn getOrCreateCustomer succeeded", { customerId });
      return customer;
    } catch (error) {
      logger.warn("Autumn getOrCreateCustomer failed", { customerId, error });
      return null;
    }
  }

  private async getEntity({
    customerId,
    entityId,
  }: GetEntityParams): Promise<unknown | null> {
    if (!autumnClient) return null;

    try {
      return await autumnClient.entities.get({ customerId, entityId });
    } catch (error) {
      const status = this.getErrorStatus(error);
      if (status === 404) {
        return null;
      }
      logger.warn("Autumn getEntity failed", { customerId, entityId, error });
      return null;
    }
  }

  private async createEntity({
    customerId,
    entityId,
    featureId,
    name,
  }: CreateEntityParams): Promise<unknown | null> {
    if (!autumnClient) return null;

    try {
      const entity = await autumnClient.entities.create({
        customerId,
        entityId,
        featureId,
        name: name ?? undefined,
      });
      logger.info("Autumn createEntity succeeded", {
        customerId,
        entityId,
        featureId,
      });
      return entity;
    } catch (error) {
      const status = this.getErrorStatus(error);
      if (status === 409) {
        return null;
      }
      logger.warn("Autumn createEntity failed", {
        customerId,
        entityId,
        featureId,
        error,
      });
      return null;
    }
  }

  private async track({
    customerId,
    entityId,
    featureId,
    value,
    properties,
  }: TrackParams): Promise<void> {
    if (!autumnClient) return;

    try {
      await autumnClient.track({
        customerId,
        entityId,
        featureId,
        value,
        properties,
      });
      logger.info("Autumn track succeeded", {
        customerId,
        entityId,
        featureId,
        value,
      });
    } catch (error) {
      logger.warn("Autumn track failed", {
        customerId,
        entityId,
        featureId,
        value,
        error,
      });
    }
  }

  private getFeatureUsage(entity: unknown, featureId: string): number {
    const usage = (entity as any)?.balances?.[featureId]?.usage;
    return typeof usage === "number" ? usage : 0;
  }

  /**
   * Ensures the Autumn customer exists for an org, caching successful lookups in-process.
   */
  async ensureOrgProvisioned({
    orgId,
    name,
    email,
  }: EnsureOrgProvisionedParams): Promise<void> {
    if (this.ensuredOrgs.has(orgId)) return;
    const customer = await this.getOrCreateCustomer({
      customerId: orgId,
      name,
      email,
    });
    if (customer) {
      this.ensuredOrgs.add(orgId);
    }
  }

  /**
   * Ensures the Autumn entity exists for a team under its org customer.
   */
  async ensureTeamProvisioned({
    teamId,
    orgId,
    name,
  }: EnsureTeamProvisionedParams): Promise<void> {
    if (this.isPreviewTeam(teamId)) return;

    try {
      const resolvedOrgId = orgId ?? await this.lookupOrgIdForTeam(teamId);
      this.customerOrgCache.set(teamId, resolvedOrgId);
      await this.ensureOrgProvisioned({ orgId: resolvedOrgId });

      if (this.ensuredTeams.has(teamId)) return;
      const entity = await this.getEntity({
        customerId: resolvedOrgId,
        entityId: teamId,
      });

      if (!entity) {
        await this.createEntity({
          customerId: resolvedOrgId,
          entityId: teamId,
          featureId: CREDITS_FEATURE_ID,
          name,
        });
        const createdEntity = await this.getEntity({
          customerId: resolvedOrgId,
          entityId: teamId,
        });
        if (!createdEntity) {
          return;
        }
      }
      this.ensuredTeams.add(teamId);
    } catch (error) {
      logger.warn("Autumn ensureTeamProvisioned failed", { teamId, error });
    }
  }

  /**
   * Resolves and warms the Autumn customer/entity context needed before tracking usage.
   */
  private async ensureTrackingContext(teamId: string): Promise<string> {
    const cached = this.customerOrgCache.get(teamId);
    if (cached) {
      await this.ensureTeamProvisioned({ teamId, orgId: cached });
      return cached;
    }

    const orgId = await this.lookupOrgIdForTeam(teamId);
    await this.ensureTeamProvisioned({ teamId, orgId });
    return orgId;
  }

  /**
   * Temporary migration shim — remove once all teams have Autumn history.
   *
   * Tracks the delta between Firecrawl's combined (scrape + extract) usage
   * and Autumn's recorded usage. `currentValue` is subtracted before the
   * comparison to avoid double-counting the event being reserved. Calls are
   * serialised per team to prevent concurrent invocations from each replaying
   * the full historical delta.
   */
  private backfillUsageIfNeeded(
    teamId: string,
    customerId: string,
  ): Promise<void> {
    const prev = this.backfillQueue.get(teamId) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // don't stall the queue on errors from the previous call
      .then(() => this._backfillUsageIfNeeded(teamId, customerId));
    this.backfillQueue.set(teamId, next);
    next.finally(() => {
      if (this.backfillQueue.get(teamId) === next) {
        this.backfillQueue.delete(teamId);
      }
    });
    return next;
  }

  private async _backfillUsageIfNeeded(
    teamId: string,
    customerId: string,
  ): Promise<void> {
    // Fetch both modes in parallel so the combined Firecrawl total is
    // comparable to Autumn's single shared TEAM_CREDITS counter.
    const [scrapeChunk, extractChunk] = await Promise.all([
      getACUCTeam(teamId, false, true, RateLimiterMode.Scrape),
      getACUCTeam(teamId, false, true, RateLimiterMode.Extract),
    ]);
    const firecrawlTotal =
      (scrapeChunk?.adjusted_credits_used ?? 0) +
      (extractChunk?.adjusted_credits_used ?? 0);

    // reserveCredits is called before the current event is committed to ACUC,
    // so firecrawlTotal already excludes it — no subtraction needed.
    if (firecrawlTotal <= 0) return;

    const entity = await this.getEntity({
      customerId,
      entityId: teamId,
    });
    const autumnUsage = this.getFeatureUsage(entity, CREDITS_FEATURE_ID);
    const delta = firecrawlTotal - autumnUsage;
    if (delta <= 0) return;

    // Use whichever chunk has period metadata; prefer scrape as the default.
    const periodChunk = scrapeChunk ?? extractChunk;
    await this.track({
      customerId,
      entityId: teamId,
      featureId: CREDITS_FEATURE_ID,
      value: delta,
      properties: {
        source: "autumn_backfill",
        firecrawlBackfill: true,
        periodStart: periodChunk?.sub_current_period_start ?? null,
        periodEnd: periodChunk?.sub_current_period_end ?? null,
      },
    });
  }

  /**
   * Records a credit usage event in Autumn at request time.
   * Returns true on success, false if Autumn is unavailable or an error occurs.
   */
  async reserveCredits({
    teamId,
    value,
    properties,
  }: TrackCreditsParams): Promise<boolean> {
    if (!autumnClient) return false;
    if (this.isPreviewTeam(teamId)) return false;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      await this.backfillUsageIfNeeded(teamId, customerId).catch(error => {
        logger.warn("Autumn backfillUsageIfNeeded failed; continuing with direct track", { teamId, value, error });
      });
      await this.track({
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        value,
        properties,
      });
      return true;
    } catch (error) {
      logger.warn("Autumn reserveCredits failed", {
        teamId,
        value,
        error,
      });
      return false;
    }
  }

  /**
   * Reverses a prior reserveCredits call by tracking a negative usage event.
   */
  async refundCredits({
    teamId,
    value,
    properties,
  }: TrackCreditsParams): Promise<void> {
    if (!autumnClient) return;
    if (this.isPreviewTeam(teamId)) return;

    try {
      const customerId = await this.ensureTrackingContext(teamId);
      await this.track({
        customerId,
        entityId: teamId,
        featureId: CREDITS_FEATURE_ID,
        value: -value,
        properties: { ...properties, source: "autumn_refund" },
      });
    } catch (error) {
      logger.warn("Autumn refundCredits failed", { teamId, value, error });
    }
  }

  /**
   * Replays recent org/team provisioning to repair missed webhook events.
   */
  async backfillRecentProvisioning(
    lookbackMs = AUTUMN_PROVISIONING_LOOKBACK_MS,
  ): Promise<void> {
    if (!autumnClient || this.backfillRunning) return;

    this.backfillRunning = true;
    try {
      const createdAfter = new Date(Date.now() - lookbackMs).toISOString();
      const [orgsResult, teamsResult] = await Promise.all([
        supabase_rr_service
          .from("organizations")
          .select("id,name")
          .gte("created_at", createdAfter),
        supabase_rr_service
          .from("teams")
          .select("id,org_id,name")
          .gte("created_at", createdAfter),
      ]);

      if (orgsResult.error) throw orgsResult.error;
      if (teamsResult.error) throw teamsResult.error;

      await Promise.all(
        (orgsResult.data ?? []).map(org =>
          this.ensureOrgProvisioned({ orgId: org.id, name: org.name }),
        ),
      );
      await Promise.all(
        (teamsResult.data ?? []).map(team =>
          this.ensureTeamProvisioned({
            teamId: team.id,
            orgId: team.org_id,
            name: team.name,
          }),
        ),
      );
    } catch (error) {
      logger.warn("Autumn provisioning backfill failed", { error });
    } finally {
      this.backfillRunning = false;
    }
  }
}

export const autumnService = new AutumnService();
