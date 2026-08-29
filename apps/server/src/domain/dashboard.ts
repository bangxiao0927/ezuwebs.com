import type { AuthUser } from "./auth/store.js";
import { listSessionsForOwner } from "./sessions.js";

export interface DashboardUserDto {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  plan: string;
}

export interface DashboardProjectDto {
  id: string;
  projectName: string;
  description: string;
  taskTitle: string;
  taskTimestamp: string;
}

export interface DashboardCountsDto {
  totalProjects: number;
}

export interface DashboardDto {
  user: DashboardUserDto;
  projects: DashboardProjectDto[];
  counts: DashboardCountsDto;
}

export async function getDashboard(user: AuthUser): Promise<DashboardDto> {
  const sessions = await listSessionsForOwner(user.id);
  const projects: DashboardProjectDto[] = sessions.map((session) => ({
    id: session.id,
    projectName: session.projectName,
    description: session.description,
    taskTitle: session.taskTitle,
    taskTimestamp: session.taskTimestamp,
  }));

  return {
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan,
      ...(user.name ? { name: user.name } : {}),
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    },
    projects,
    counts: { totalProjects: projects.length },
  };
}
