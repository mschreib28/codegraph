import { describe, it, expect } from 'vitest';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

describe('FrameworkResolver.extract interface', () => {
  it('extract() returns { nodes, references }', () => {
    const resolver: FrameworkResolver = {
      name: 'fake',
      detect: () => true,
      resolve: () => null,
      languages: ['python'],
      extract: (_filePath: string, _content: string) => ({
        nodes: [] as Node[],
        references: [] as UnresolvedRef[],
      }),
    };
    const result = resolver.extract!('foo.py', '');
    expect(result).toEqual({ nodes: [], references: [] });
  });
});

import { getApplicableFrameworks } from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';

describe('getApplicableFrameworks', () => {
  const pyFw: FrameworkResolver = { name: 'py', languages: ['python'], detect: () => true, resolve: () => null };
  const jsFw: FrameworkResolver = { name: 'js', languages: ['javascript', 'typescript'], detect: () => true, resolve: () => null };
  const anyFw: FrameworkResolver = { name: 'any', detect: () => true, resolve: () => null };

  it('filters by language', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'python');
    expect(result.map(r => r.name)).toEqual(['py', 'any']);
  });

  it('returns anyFw-only when language has no matches', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'rust');
    expect(result.map(r => r.name)).toEqual(['any']);
  });
});

import { djangoResolver } from '../src/resolution/frameworks/python';

describe('djangoResolver.extract', () => {
  it('extracts route node and reference for path() with CBV.as_view()', () => {
    const src = `
from django.urls import path
from users.views import UserListView

urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
]
`;
    const { nodes, references } = djangoResolver.extract!('users/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('users/');
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
    expect(references[0].referenceKind).toBe('references');
    expect(references[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts route for path() with dotted module.Class.as_view()', () => {
    const src = `from django.urls import path\nfrom api.v1 import views as api_v1_views\nurlpatterns = [path('api/', api_v1_views.UserListView.as_view())]\n`;
    const { nodes, references } = djangoResolver.extract!('api/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
  });

  it('extracts route for path() with bare function view', () => {
    const src = `from django.urls import path\nurlpatterns = [path('home/', home_view, name='home')]\n`;
    const { nodes, references } = djangoResolver.extract!('home/urls.py', src);
    expect(references[0].referenceName).toBe('home_view');
  });

  it('extracts route for path() with include()', () => {
    const src = `from django.urls import path, include\nurlpatterns = [path('api/', include('api.urls'))]\n`;
    const { nodes, references } = djangoResolver.extract!('root/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(references[0].referenceName).toBe('api.urls');
    expect(references[0].referenceKind).toBe('imports');
  });

  it('extracts routes for re_path and url', () => {
    const src = `from django.urls import re_path, url\nurlpatterns = [re_path(r'^users/$', UserView), url(r'^old/$', OldView)]\n`;
    const { nodes } = djangoResolver.extract!('legacy/urls.py', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['^users/$', '^old/$']);
  });

  it('returns empty result for a non-urls.py python file', () => {
    const src = `def foo(): return 1\n`;
    const { nodes, references } = djangoResolver.extract!('views.py', src);
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });
});

import { flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python';

describe('flaskResolver.extract', () => {
  it('extracts route and reference from @app.route', () => {
    const src = `
@app.route('/users')
def list_users():
    return []
`;
    const { nodes, references } = flaskResolver.extract!('app.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts blueprint routes', () => {
    const src = `
@users_bp.route('/<id>', methods=['POST'])
def create_user(id):
    pass
`;
    const { nodes, references } = flaskResolver.extract!('routes.py', src);
    expect(nodes[0].name).toBe('POST /<id>');
    expect(references[0].referenceName).toBe('create_user');
  });
});

describe('fastapiResolver.extract', () => {
  it('extracts route and reference from @app.get', () => {
    const src = `
@app.get('/users')
async def list_users():
    return []
`;
    const { nodes, references } = fastapiResolver.extract!('main.py', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts route from router.post', () => {
    const src = `
@router.post('/items')
def create_item(item: Item):
    pass
`;
    const { nodes, references } = fastapiResolver.extract!('items.py', src);
    expect(nodes[0].name).toBe('POST /items');
    expect(references[0].referenceName).toBe('create_item');
  });
});
