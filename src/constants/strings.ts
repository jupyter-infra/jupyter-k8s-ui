// UI Strings - centralized for easy updates and i18n readiness

export const strings = {
  app: {
    name: 'Jupyter Workspaces',
    logo: 'J',
  },

  common: {
    loading: 'Loading...',
    cancel: 'Cancel',
    confirm: 'Confirm',
    delete: 'Delete',
    deleting: 'Deleting...',
    back: 'Back',
    private: 'Private',
    public: 'Public',
    cores: 'cores',
    gb: 'GB',
    min: 'min',
  },

  workspace: {
    // List page
    listTitle: 'Workspaces',
    listDescription: 'Create and manage your Jupyter development environments',
    searchPlaceholder: 'Search workspaces...',
    filterAll: 'All',
    filterMine: 'My Workspaces',
    newWorkspace: 'New Workspace',
    refresh: 'Refresh',
    createWorkspace: 'Create Workspace',
    noWorkspacesYet: 'No workspaces yet',
    noWorkspacesFound: 'No workspaces found',
    noWorkspacesDescription: 'Create your first workspace to get started',
    noWorkspacesSearchDescription: 'Try adjusting your search or filters',
    sessionExpired: 'Session expired',
    sessionExpiredDescription: 'Your session has expired. Please sign in again to continue.',
    signInAgain: 'Sign in again',

    // Card
    moreOptions: 'More options',
    openWorkspace: 'Open workspace',
    open: 'Open',
    details: 'Details',
    start: 'Start',
    stop: 'Stop',
    viewOnly: 'View only',
    viewDetails: 'View details',

    // Detail page
    detailConditions: 'Conditions',
    detailInfo: 'Information',

    // Status
    statusRunning: 'Running',
    statusStarting: 'Starting',
    statusStopped: 'Stopped',

    // Create page
    createTitle: 'Create Workspace',
    createDescription: 'Configure your new development environment',

    // Form sections
    sectionWorkspace: 'Workspace',
    sectionTemplate: 'Template',
    sectionBasicInfo: 'Basic Information',
    sectionEnvironment: 'Environment',
    sectionResources: 'Resources',
    sectionAccess: 'Access',
    sectionIdleShutdown: 'Idle Shutdown',
    sectionSettings: 'Settings',

    // Idle shutdown
    idleShutdownEnable: 'Enable automatic shutdown when idle',
    idleShutdownTimeout: 'Idle timeout',

    // Form fields
    fieldName: 'Name',
    fieldNamePlaceholder: 'my-workspace',
    fieldNameHelper: 'Lowercase letters, numbers, and hyphens',
    fieldDisplayName: 'Display Name',
    fieldTemplate: 'Template (optional)',
    fieldTemplatePlaceholder: 'Select a template...',
    fieldImage: 'Image',
    fieldImagePlaceholder: 'Select or enter a custom image...',
    fieldImageHelper: 'You can enter any container image URL',
    fieldMountPath: 'Storage Mount Path',
    fieldMountPathHelper: 'Directory where persistent storage will be mounted',

    // Resources
    resourceCpu: 'CPU',
    resourceMemory: 'Memory',
    resourceStorage: 'Storage',

    // Access
    accessQuestion: 'Who can access this workspace?',
    accessPublicTitle: 'Public',
    accessPublicDescription: 'Anyone can connect',
    accessPrivateTitle: 'Private',
    accessPrivateDescription: 'Only you can connect',

    // Create page hints
    advancedHint: 'Need more options (custom images, GPU, pod security)?',
    advancedHintKubectl: 'Use kubectl',
    advancedHintOr: 'or see the',
    advancedHintDocs: 'full CRD reference',
    advancedHintDocsUrl: 'https://jupyter-k8s.readthedocs.io/en/latest/reference/custom-resources/workspace.html',

    // Delete dialog
    deleteTitle: 'Delete Workspace',
    deleteMessage: (name: string) => `Are you sure you want to delete "${name}"? This action cannot be undone.`,
  },

  kubectl: {
    navTooltip: 'Kubectl Access',
    navAriaLabel: 'Kubectl access',
    title: 'Kubectl Access',
    description: 'Connect to this cluster from your terminal.',
    instruction: 'Copy the script below and paste it into your terminal. It will configure kubectl to connect to this cluster.',
    infoCaption: 'These values are pre-configured in the script below.',
    verifyHint: 'After running, verify with:',
    verifyCommand: 'kubectl get workspaces',
    copy: 'Copy',
    download: 'Download',
    copied: 'Copied!',
    unavailable: 'Cluster access configuration is not available. An administrator needs to configure the OIDC environment variables on the server.',
    osMac: 'macOS',
    osLinux: 'Linux',
    osWindows: 'Windows',
    clusterLabel: 'Cluster',
    issuerLabel: 'Issuer',
    clientLabel: 'Client ID',
    bannerTitle: 'Prefer the terminal?',
    bannerDescription: 'Run a one-time script to configure kubectl for this cluster.',
    bannerAction: 'Get script',
    bannerHint: 'Always available via the',
    bannerHintIcon: 'in the toolbar.',
  },

  error: {
    title: 'Something went wrong',
    description: 'An unexpected error occurred. Please try refreshing the page or go back to the home page.',
    goHome: 'Go to Home',
  },

  theme: {
    switchToLight: 'Switch to light mode',
    switchToDark: 'Switch to dark mode',
    toggle: 'Toggle theme',
  },

  a11y: {
    searchWorkspaces: 'Search workspaces',
    filterWorkspaces: 'Filter workspaces',
    homeLink: 'Jupyter Workspaces Home',
    userMenu: (username: string) => `User: ${username}`,
    workspaceCard: (name: string, status: string) => `${name} workspace, ${status}`,
    resourceSlider: (resource: string, value: number, unit: string) => `${resource}: ${value} ${unit}`,
    templateCard: (name: string) => `Select ${name} template`,
  },
} as const;

// Image options - using short names that map to built-in images in the controller
export const imageOptions = [
  {
    value: 'uv',
    label: 'Python UV',
    description: 'Fast Python with UV package manager',
  },
  {
    value: 'jupyter/base-notebook:latest',
    label: 'JupyterLab',
    description: 'Classic Jupyter notebook environment',
  },
] as const;

// Resource configuration
export const resourceBounds = {
  cpu: { min: 0.5, max: 8, step: 0.5, unit: 'cores' },
  memory: { min: 1, max: 16, step: 1, unit: 'GB' },
  storage: { min: 5, max: 100, step: 5, unit: 'GB' },
} as const;
