import { useState, useMemo } from 'react';
import { Box, Button, Menu, MenuList, MenuItem, ListItemText, InputBase, Divider, Typography, CircularProgress, IconButton, Tooltip } from '@mui/material';
import { KeyboardArrowDown, Refresh, Check } from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import { useNamespace, namespaceKeys } from '../../context/NamespaceContext';
import { useNamespaces } from '../../api/hooks';
import { apiClient } from '../../api/client';
import { strings } from '../../constants';

// The namespace switcher: persistent active-namespace label in the app chrome AND the
// control to change it. Opening it triggers the lazy SSAR fan-out (useNamespaces enabled
// only while open). A typeahead filters the allowed list; a name that isn't in the list
// (past the cap, or reached via a direct RoleBinding) falls to the live find-by-name SSAR.
export function NamespaceSwitcher() {
  const { activeNamespace, setActiveNamespace } = useNamespace();
  const queryClient = useQueryClient();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [filter, setFilter] = useState('');
  // find-by-name outcome for the typed candidate: `denied` = SSAR ran and said no; `errored`
  // = the SSAR call itself failed (unknown access), shown only after a retry also failed.
  const [findState, setFindState] = useState<{ checking: boolean; denied: string | null; errored: string | null }>({
    checking: false,
    denied: null,
    errored: null,
  });

  const open = Boolean(anchorEl);
  // Lazy: the fan-out runs only while the menu is open. Paged — accumulate all loaded pages.
  const { data, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage } = useNamespaces(open);
  const allowed = useMemo(() => (data?.pages ?? []).flatMap((p) => p.items.map((i) => i.namespace)), [data]);
  // Loading spinner only for the FIRST page; subsequent pages show inline under the list.
  const isLoadingFirstPage = isFetching && !isFetchingNextPage && allowed.length === 0;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = q ? allowed.filter((ns) => ns.toLowerCase().includes(q)) : allowed;
    return [...base].sort();
  }, [allowed, filter]);

  // A typed name that matches nothing in the allowed list is a find-by-name candidate.
  const findCandidate = useMemo(() => {
    const q = filter.trim();
    if (!q) return null;
    return allowed.some((ns) => ns === q) ? null : q;
  }, [allowed, filter]);

  const closeMenu = () => {
    setAnchorEl(null);
    setFilter('');
    setFindState({ checking: false, denied: null, errored: null });
  };

  const select = (ns: string) => {
    setActiveNamespace(ns);
    closeMenu();
  };

  const handleFind = async (ns: string) => {
    setFindState({ checking: true, denied: null, errored: null });
    // The SSAR call is a display hint, not the enforcement, so a transient failure shouldn't
    // masquerade as "access denied" (that would mislead a user who DOES have access). Retry
    // ONCE on a thrown error; a definitive allowed/denied verdict ends it immediately. Only a
    // second failure surfaces a generic "couldn't check" message.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await apiClient.checkNamespaceAccess(ns);
        if (res.allowed) select(ns);
        else setFindState({ checking: false, denied: ns, errored: null });
        return; // definitive verdict (allow or deny) — done
      } catch {
        if (attempt === 0) continue; // retry once
        setFindState({ checking: false, denied: null, errored: ns });
      }
    }
  };

  const refresh = () => {
    // Manual refresh: force the server to recompute (bypass its cached visible snapshot),
    // resetting to page 0. Seed the infinite query's first page with a refresh=1 fetch, then
    // remove trailing pages so the next scroll re-pages from the fresh page 0.
    void queryClient.fetchInfiniteQuery({
      queryKey: namespaceKeys.list,
      queryFn: () => apiClient.listNamespaces({ refresh: true }),
      initialPageParam: 0,
      getNextPageParam: () => undefined,
      pages: 1,
    });
  };

  return (
    <Box>
      <Button
        onClick={(e) => setAnchorEl(e.currentTarget)}
        size="small"
        variant="outlined"
        endIcon={<KeyboardArrowDown />}
        aria-label={strings.namespace.switcherAriaLabel}
        sx={{ textTransform: 'none', maxWidth: 260 }}
      >
        <Typography component="span" variant="body2" noWrap>
          <Box component="span" sx={{ color: 'text.secondary', mr: 0.5 }}>
            {strings.namespace.label}:
          </Box>
          {activeNamespace ?? '…'}
        </Typography>
      </Button>

      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={closeMenu}
        slotProps={{ paper: { sx: { width: 320, maxHeight: 420 } } }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ px: 1.5, py: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <InputBase
            autoFocus
            fullWidth
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={strings.namespace.searchPlaceholder}
            inputProps={{ 'aria-label': strings.namespace.searchPlaceholder }}
            sx={{ fontSize: 14, border: 1, borderColor: 'divider', borderRadius: 1, px: 1, py: 0.5 }}
          />
          <Tooltip title={strings.namespace.refresh}>
            <IconButton size="small" onClick={refresh} aria-label={strings.namespace.refresh}>
              <Refresh fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Divider />

        {isLoadingFirstPage && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        )}

        {!isLoadingFirstPage && (
          <MenuList dense sx={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.map((ns) => (
              <MenuItem key={ns} selected={ns === activeNamespace} onClick={() => select(ns)}>
                {ns === activeNamespace && <Check fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />}
                <ListItemText primary={ns} sx={{ ml: ns === activeNamespace ? 0 : 3 }} />
              </MenuItem>
            ))}
            {filtered.length === 0 && !findCandidate && (
              <MenuItem disabled>
                <ListItemText primary={strings.namespace.noneTitle} />
              </MenuItem>
            )}
            {/* Load more: only when not filtering (paging the full ordered list, not a search). */}
            {hasNextPage && !filter.trim() && (
              <MenuItem onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                <ListItemText
                  primary={isFetchingNextPage ? strings.namespace.loadingMore : strings.namespace.loadMore}
                  slotProps={{ primary: { color: 'primary', fontWeight: 600 } }}
                />
              </MenuItem>
            )}
          </MenuList>
        )}

        {/* Return arrays (not Fragments) so MUI's Menu can clone/key each child directly —
            a Fragment child triggers "Menu doesn't accept a Fragment as a child". */}
        {findCandidate && [
          <Divider key="find-divider" />,
          <MenuItem key="find-item" onClick={() => handleFind(findCandidate)} disabled={findState.checking}>
            <ListItemText
              primary={findState.checking ? strings.namespace.findChecking : `Find "${findCandidate}"`}
              secondary={
                findState.denied === findCandidate
                  ? strings.namespace.findNotAllowed(findCandidate)
                  : findState.errored === findCandidate
                    ? strings.namespace.findCheckFailed
                    : undefined
              }
            />
          </MenuItem>,
        ]}

        {hasNextPage && [
          <Divider key="more-divider" />,
          <Box key="more-hint" sx={{ px: 1.5, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {strings.namespace.moreHint}
            </Typography>
          </Box>,
        ]}
      </Menu>
    </Box>
  );
}
