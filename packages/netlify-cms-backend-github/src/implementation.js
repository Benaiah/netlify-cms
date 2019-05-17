import React from 'react';
import trimStart from 'lodash/trimStart';
import semaphore from 'semaphore';
import { stripIndent } from 'common-tags';
import AuthenticationPage from './AuthenticationPage';
import API from './API';

const MAX_CONCURRENT_DOWNLOADS = 10;

/**
 * Keywords for inferring a status that will provide a deploy preview URL.
 */
const PREVIEW_CONTEXT_KEYWORDS = ['deploy'];

/**
 * Check a given status context string to determine if it provides a link to a
 * deploy preview. Checks for an exact match against `previewContext` if given,
 * otherwise checks for inclusion of a value from `PREVIEW_CONTEXT_KEYWORDS`.
 */
function isPreviewContext(context, previewContext) {
  if (previewContext) {
    return context === previewContext;
  }
  return PREVIEW_CONTEXT_KEYWORDS.some(keyword => context.includes(keyword));
}

/**
 * Retrieve a deploy preview URL from an array of statuses. By default, a
 * matching status is inferred via `isPreviewContext`.
 */
function getPreviewStatus(statuses, config) {
  const previewContext = config.getIn(['backend', 'preview_context']);
  return statuses.find(({ context }) => {
    return isPreviewContext(context, previewContext);
  });
}

export default class GitHub {
  constructor(config, options = {}) {
    this.config = config;
    this.options = {
      proxied: false,
      API: null,
      ...options,
    };

    if (!this.options.proxied && config.getIn(['backend', 'repo']) == null) {
      throw new Error('The GitHub backend needs a "repo" in the backend configuration.');
    }

    this.api = this.options.API || null;

    this.forkWorkflowEnabled = config.getIn(['backend', 'fork_workflow'], false);
    if (this.forkWorkflowEnabled) {
      if (!this.options.useWorkflow) {
        throw new Error(
          'backend.fork_workflow is true but publish_mode is not set to editorial_workflow.',
        );
      }
      this.originRepo = config.getIn(['backend', 'repo'], '');
    } else {
      this.repo = config.getIn(['backend', 'repo'], '');
    }
    this.branch = config.getIn(['backend', 'branch'], 'master').trim();
    this.api_root = config.getIn(['backend', 'api_root'], 'https://api.github.com');
    this.token = '';
    this.squash_merges = config.getIn(['backend', 'squash_merges']);
  }

  authComponent() {
    const wrappedAuthenticationPage = props => <AuthenticationPage {...props} backend={this} />;
    wrappedAuthenticationPage.displayName = 'AuthenticationPage';
    return wrappedAuthenticationPage;
  }

  restoreUser(user) {
    return this.forkWorkflowEnabled
      ? this.authenticateWithFork({ userData: user, getPermissionToFork: () => true }).then(() =>
          this.authenticate(user),
        )
      : this.authenticate(user);
  }

  async pollUntilForkExists({ repo, token }) {
    const pollDelay = 250; // milliseconds
    var repoExists = false;
    while (!repoExists) {
      repoExists = await fetch(`${this.api_root}/repos/${repo}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(() => true)
        .catch(err => (err && err.status === 404 ? false : Promise.reject(err)));
      // wait between polls
      if (!repoExists) {
        await new Promise(resolve => setTimeout(resolve, pollDelay));
      }
    }
    return Promise.resolve();
  }

  async currentUser({ token }) {
    if (!this._currentUserPromise) {
      this._currentUserPromise = fetch(`${this.api_root}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }).then(res => res.json());
    }
    return this._currentUserPromise;
  }

  async userIsOriginMaintainer({ username: usernameArg, token }) {
    const username = usernameArg || (await this.currentUser({ token })).login;
    this._userIsOriginMaintainerPromises = this._userIsOriginMaintainerPromises || {};
    if (!this._userIsOriginMaintainerPromises[username]) {
      this._userIsOriginMaintainerPromises[username] = fetch(
        `${this.api_root}/repos/${this.originRepo}/collaborators/${username}/permission`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      )
        .then(res => res.json())
        .then(
          ({ permission }) =>
            console.log(permission) || permission === 'admin' || permission === 'write',
        );
    }
    return this._userIsOriginMaintainerPromises[username];
  }

  async authenticateWithFork({ userData, getPermissionToFork }) {
    if (!this.forkWorkflowEnabled) {
      throw new Error('Cannot authenticate with fork; forking workflow is turned off.');
    }
    const { token } = userData;

    // Origin maintainers should be able to use the CMS normally
    if (await this.userIsOriginMaintainer({ token })) {
      console.log('USER IS ORIGIN MAINTAINER!');
      this.repo = this.originRepo;
      this.useForkWorkflow = false;
      return Promise.resolve();
    }

    await getPermissionToFork();

    const fork = await fetch(`${this.api_root}/repos/${this.originRepo}/forks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }).then(res => res.json());
    this.useForkWorkflow = true;
    this.repo = fork.full_name;
    return this.pollUntilForkExists({ repo: fork.full_name, token });
  }

  async authenticate(state) {
    this.token = state.token;
    this.api = new API({
      token: this.token,
      branch: this.branch,
      repo: this.repo,
      originRepo: this.useForkWorkflow ? this.originRepo : undefined,
      api_root: this.api_root,
      squash_merges: this.squash_merges,
      useForkWorkflow: this.useForkWorkflow,
      initialWorkflowStatus: this.options.initialWorkflowStatus,
    });
    const user = await this.api.user();
    const isCollab = await this.api.hasWriteAccess().catch(error => {
      error.message = stripIndent`
        Repo "${this.repo}" not found.

        Please ensure the repo information is spelled correctly.

        If the repo is private, make sure you're logged into a GitHub account with access.

        If your repo is under an organization, ensure the organization has granted access to Netlify
        CMS.
      `;
      throw error;
    });

    // Unauthorized user
    if (!isCollab) {
      throw new Error('Your GitHub user account does not have access to this repo.');
    }

    // Authorized user
    return { ...user, token: state.token };
  }

  logout() {
    this.token = null;
    return;
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  async entriesByFolder(collection, extension) {
    const repoURL = `repos/${this.useForkWorkflow ? this.originRepo : this.repo}`;
    const files = await this.api.listFiles(collection.get('folder'));
    const filteredFiles = files.filter(file => file.name.endsWith('.' + extension));
    return this.fetchFiles(filteredFiles, { repoURL });
  }

  entriesByFiles(collection) {
    const repoURL = `repos/${this.useForkWorkflow ? this.originRepo : this.repo}`;
    const files = collection.get('files').map(collectionFile => ({
      path: collectionFile.get('file'),
      label: collectionFile.get('label'),
    }));
    return this.fetchFiles(files, { repoURL });
  }

  fetchFiles = (files, { repoURL = `/repos/${this.repo}` } = {}) => {
    const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
    const promises = [];
    files.forEach(file => {
      promises.push(
        new Promise(resolve =>
          sem.take(() =>
            this.api
              .readFile(file.path, file.sha, { repoURL })
              .then(data => {
                resolve({ file, data });
                sem.leave();
              })
              .catch((err = true) => {
                sem.leave();
                console.error(`failed to load file from GitHub: ${file.path}`);
                resolve({ error: err });
              }),
          ),
        ),
      );
    });
    return Promise.all(promises).then(loadedEntries =>
      loadedEntries.filter(loadedEntry => !loadedEntry.error),
    );
  };

  // Fetches a single entry.
  getEntry(collection, slug, path) {
    const repoURL = `repos/${this.useForkWorkflow ? this.originRepo : this.repo}`;
    return this.api.readFile(path, null, { repoURL }).then(data => ({
      file: { path },
      data,
    }));
  }

  getMedia() {
    return this.api.listFiles(this.config.get('media_folder')).then(files =>
      files.map(({ sha, name, size, download_url, path }) => {
        const url = new URL(download_url);
        if (url.pathname.match(/.svg$/)) {
          url.search += (url.search.slice(1) === '' ? '?' : '&') + 'sanitize=true';
        }
        return { id: sha, name, size, displayURL: url.href, path };
      }),
    );
  }

  persistEntry(entry, mediaFiles = [], options = {}) {
    return this.api.persistFiles(entry, mediaFiles, options);
  }

  async persistMedia(mediaFile, options = {}) {
    try {
      await this.api.persistFiles(null, [mediaFile], options);

      const { sha, value, path, fileObj } = mediaFile;
      const displayURL = URL.createObjectURL(fileObj);
      return {
        id: sha,
        name: value,
        size: fileObj.size,
        displayURL,
        path: trimStart(path, '/'),
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  deleteFile(path, commitMessage, options) {
    return this.api.deleteFile(path, commitMessage, options);
  }

  unpublishedEntries() {
    return this.api
      .listUnpublishedBranches()
      .then(branches => {
        const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
        const promises = [];
        branches.map(({ ref }) => {
          promises.push(
            new Promise(resolve => {
              const contentKey = ref.split('refs/heads/cms/').pop();
              console.log(contentKey);
              const slug = contentKey.split('/').pop();
              return sem.take(() =>
                this.api
                  .readUnpublishedBranchFile(contentKey)
                  .then(data => {
                    console.log({ data });
                    if (data === null || data === undefined) {
                      resolve(null);
                      sem.leave();
                    } else {
                      const path = data.metaData.objects.entry.path;
                      resolve({
                        slug,
                        file: { path },
                        data: data.fileData,
                        metaData: data.metaData,
                        isModification: data.isModification,
                      });
                      sem.leave();
                    }
                  })
                  .catch(() => {
                    sem.leave();
                    resolve(null);
                  }),
              );
            }),
          );
        });
        return Promise.all(promises);
      })
      .catch(error => {
        debugger;
        if (error.message === 'Not Found') {
          return Promise.resolve([]);
        }
        return Promise.reject(error);
      });
  }

  unpublishedEntry(collection, slug) {
    const contentKey = this.api.generateContentKey(collection.get('name'), slug);
    return this.api.readUnpublishedBranchFile(contentKey).then(data => {
      if (!data) return null;
      return {
        slug,
        file: { path: data.metaData.objects.entry.path },
        data: data.fileData,
        metaData: data.metaData,
        isModification: data.isModification,
      };
    });
  }

  /**
   * Uses GitHub's Statuses API to retrieve statuses, infers which is for a
   * deploy preview via `getPreviewStatus`. Returns the url provided by the
   * status, as well as the status state, which should be one of 'success',
   * 'pending', and 'failure'.
   */
  async getDeployPreview(collection, slug) {
    const contentKey = this.api.generateContentKey(collection.get('name'), slug);
    const data = await this.api.retrieveMetadata(contentKey);

    if (!data || !data.pr) {
      return null;
    }

    const statuses = await this.api.getStatuses(data.pr.head);
    const deployStatus = getPreviewStatus(statuses, this.config);

    if (deployStatus) {
      const { target_url, state } = deployStatus;
      return { url: target_url, status: state };
    }
  }

  updateUnpublishedEntryStatus(collection, slug, newStatus) {
    return this.api.updateUnpublishedEntryStatus(collection, slug, newStatus);
  }

  deleteUnpublishedEntry(collection, slug) {
    return this.api.deleteUnpublishedEntry(collection, slug);
  }
  publishUnpublishedEntry(collection, slug) {
    return this.api.publishUnpublishedEntry(collection, slug);
  }
}
