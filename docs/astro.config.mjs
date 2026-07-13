import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://tigorlazuardi.github.io',
  base: '/pi-sheepdog',
  integrations: [
    starlight({
      title: 'pi-sheepdog',
      description: 'Consumer docs and blackbox QA contract for Sheepdog.',
      sidebar: [
        {
          label: 'Docs',
          items: [
            { slug: 'overview', label: 'Overview' },
            { slug: 'install', label: 'Install' },
            { slug: 'quickstart', label: 'Quickstart' },
            { slug: 'commands-and-panel', label: 'Commands and panel' },
            { slug: 'configuration', label: 'Configuration' },
            { slug: 'behavior-contract', label: 'Behavior contract' },
            { slug: 'blackbox-qa-checklist', label: 'Blackbox QA checklist' },
            { slug: 'troubleshooting', label: 'Troubleshooting' },
            { slug: 'reference', label: 'Reference' }
          ]
        }
      ]
    })
  ]
});
