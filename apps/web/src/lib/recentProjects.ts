import type { DashboardProject } from "../types";

/**
 * Caps the signed-in user's project list to the most recent `max` entries for
 * the resume grid on the session-select page. The backend returns projects in
 * creation order, so the tail holds the newest; we surface those first.
 */
export function recentProjects(projects: DashboardProject[], max = 6): DashboardProject[] {
  if (max <= 0) {
    return [];
  }
  if (projects.length <= max) {
    return [...projects].reverse();
  }
  return projects.slice(projects.length - max).reverse();
}
