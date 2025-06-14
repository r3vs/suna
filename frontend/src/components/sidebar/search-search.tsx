'use client';

import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';
import { Search, X, FileText, Loader2 } from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { format } from 'date-fns';
import Link from 'next/link';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { getProjects, getThreads, Project, Thread } from '@/lib/api';

// Thread with associated project info for display in sidebar & search
type ThreadWithProject = {
  threadId: string;
  projectId: string;
  projectName: string;
  url: string;
  updatedAt: string;
};

export function SidebarSearch() {
  const [query, setQuery] = useState('');
  const [threads, setThreads] = useState<ThreadWithProject[]>([]);
  const [filteredThreads, setFilteredThreads] = useState<ThreadWithProject[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const { state } = useSidebar();

  // Helper to sort threads by updated_at (most recent first)
  const sortThreads = (
    threadsList: ThreadWithProject[],
  ): ThreadWithProject[] => {
    return [...threadsList].sort((a, b) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  };

  // Load threads (reusing the same logic from NavAgents)
  const loadThreadsWithProjects = async () => {
    try {
      setIsLoading(true);

      // Get all projects
      const projects = await getProjects();

      if (projects.length === 0) {
        setThreads([]);
        setFilteredThreads([]); // Assicurati di resettare anche i thread filtrati
        return;
      }

      // Create a map of projects by ID for faster lookups
      const projectsById = new Map<string, Project>(); // Tipizziamo la mappa
      projects.forEach((project) => {
        // Assumendo che 'project_id' sia la chiave corretta come usata altrove
        projectsById.set(project.project_id, project);
      });

      // Array per raccogliere tutti i thread da tutti i progetti
      let allThreadsFromAllProjects: Thread[] = [];

      // Itera su ogni progetto per ottenere i suoi thread
      for (const project of projects) {
        try {
          const threadsForProject = await getThreads(project.project_id);
          allThreadsFromAllProjects = allThreadsFromAllProjects.concat(threadsForProject);
        } catch (err) {
          console.warn(`Error loading threads for project ${project.project_id}:`, err);
          // Continua con gli altri progetti anche se uno fallisce
        }
      }

      // Create display objects for threads with their project info
      const threadsWithProjects: ThreadWithProject[] = [];

      for (const thread of allThreadsFromAllProjects) {
        const projectId = thread.project_id;
        if (!projectId) continue;

        const project = projectsById.get(projectId);
        if (!project) continue;

        threadsWithProjects.push({
          threadId: thread.thread_id,
          projectId: projectId,
          projectName: project.name || 'Unnamed Project',
          url: `/agents/${thread.thread_id}`,
          updatedAt:
            thread.updated_at || project.updated_at || new Date().toISOString(),
        });
      }

      const sortedThreads = sortThreads(threadsWithProjects);
      setThreads(sortedThreads);
      setFilteredThreads(sortedThreads);
    } catch (err) {
      console.error('Error loading threads for search:', err);
      setThreads([]);
      setFilteredThreads([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter threads based on search query
  const filterThreads = useCallback(
    (searchQuery: string) => {
      if (!searchQuery.trim()) {
        setFilteredThreads(threads);
        return;
      }

      const query = searchQuery.toLowerCase();
      const filtered = threads.filter((thread) =>
        thread.projectName.toLowerCase().includes(query),
      );

      setFilteredThreads(filtered);
    },
    [threads],
  );

  // Update filtered threads when query changes
  useEffect(() => {
    filterThreads(query);
  }, [query, filterThreads]);

  // Load threads when the component mounts
  useEffect(() => {
    loadThreadsWithProjects();
  }, []);

  // Reset loading state when navigation completes
  useEffect(() => {
    setLoadingThreadId(null);
  }, [pathname]);

  // Handle keyboard shortcut to focus search (CMD+K or CTRL+K)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === '/') {
        e.preventDefault();
        document.getElementById('sidebar-search-input')?.focus();
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  // Handle thread click with loading state
  const handleThreadClick = (
    e: React.MouseEvent<HTMLAnchorElement>,
    threadId: string,
    url: string,
  ) => {
    e.preventDefault();
    setLoadingThreadId(threadId);
    router.push(url);
  };

  return (
    <SidebarGroup>
      {/* Search input in sidebar */}
      <div className="flex items-center px-2 pt-3 pb-2">
        <div className="relative w-full">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="sidebar-search-input"
            type="text"
            placeholder="Search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 pl-8 pr-8
                      text-sm transition-colors placeholder:text-muted-foreground
                      focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm
                        opacity-70 hover:opacity-100 focus:outline-none"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Search results */}
      <SidebarGroupLabel>
        {query ? 'Search Results' : 'Recent'}
      </SidebarGroupLabel>
      <SidebarMenu className="overflow-y-auto max-h-[calc(100vh-270px)] [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']">
        {isLoading ? (
          // Show skeleton loaders while loading
          Array.from({ length: 3 }).map((_, index) => (
            <SidebarMenuItem key={`skeleton-${index}`}>
              <SidebarMenuButton>
                <div className="h-4 w-4 bg-sidebar-foreground/10 rounded-md animate-pulse"></div>
                <div className="h-3 bg-sidebar-foreground/10 rounded w-3/4 animate-pulse"></div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))
        ) : filteredThreads.length > 0 ? (
          // Show all filtered threads
          filteredThreads.map((thread, index) => {
            // Check if this thread is currently active
            const isActive = pathname?.includes(thread.threadId) || false;
            const isThreadLoading = loadingThreadId === thread.threadId;
            const updatedDate = new Date(thread.updatedAt);
            const isToday =
              new Date().toDateString() === updatedDate.toDateString();
            const isYesterday =
              new Date(Date.now() - 86400000).toDateString() ===
              updatedDate.toDateString();

            // Format date as "today", "yesterday", or formatted date
            let dateDisplay;
            if (isToday) {
              dateDisplay = 'Today';
            } else if (isYesterday) {
              dateDisplay = 'Yesterday';
            } else {
              dateDisplay = format(updatedDate, 'MMM d, yyyy');
            }

            return (
              <SidebarMenuItem key={`thread-${thread.threadId}-${index}`}>
                <SidebarMenuButton
                  asChild
                  className={
                    isActive
                      ? 'bg-accent text-accent-foreground font-medium'
                      : ''
                  }
                >
                  <Link
                    href={thread.url}
                    onClick={(e) =>
                      handleThreadClick(e, thread.threadId, thread.url)
                    }
                    className="flex items-center justify-between w-full"
                  >
                    <div className="flex items-center">
                      {isThreadLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
                      ) : (
                        <FileText className="mr-2 h-4 w-4 shrink-0" />
                      )}
                      <span className="truncate">{thread.projectName}</span>
                    </div>
                    <span className="ml-2 text-xs text-muted-foreground shrink-0">
                      {dateDisplay}
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })
        ) : (
          // Empty state
          <SidebarMenuItem>
            <SidebarMenuButton className="text-sidebar-foreground/70">
              <FileText className="h-4 w-4" />
              <span>{query ? 'No results found' : 'No agents yet'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
