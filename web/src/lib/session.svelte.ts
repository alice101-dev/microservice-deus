import { authClient, forgetToken } from "./auth";
import { setUser } from "./interactions";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

class Session {
  user = $state<SessionUser | null>(null);
  organizations = $state<Organization[]>([]);
  activeOrganizationId = $state<string | null>(null);
  loaded = $state(false);

  get organization() {
    return this.organizations.find((organization) => organization.id === this.activeOrganizationId) ?? null;
  }

  async load() {
    const { data } = await authClient.getSession();
    this.user = data?.user ? { id: data.user.id, name: data.user.name, email: data.user.email } : null;
    setUser(this.user?.id ?? null);
    this.activeOrganizationId =
      (data?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ?? null;
    if (this.user) {
      const organizations = await authClient.organization.list();
      this.organizations = (organizations.data ?? []).map((organization) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      }));
    } else {
      this.organizations = [];
    }
    this.loaded = true;
  }

  async ensure() {
    if (!this.loaded) await this.load();
  }

  async setActive(organizationId: string) {
    const result = await authClient.organization.setActive({ organizationId });
    if (result.error) throw new Error(result.error.message ?? "Tidak dapat memilih organisasi");
    forgetToken();
    await this.load();
  }

  async signOut() {
    await authClient.signOut();
    forgetToken();
    setUser(null);
    this.user = null;
    this.organizations = [];
    this.activeOrganizationId = null;
  }
}

export const session = new Session();
