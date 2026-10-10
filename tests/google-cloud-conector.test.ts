import { describe, expect, it } from 'vitest';
import { bloqueadoNoConectorGcp, contaDoConectorGcp, googleCloudParaHeader, maskServiceAccountJson, nomeConectorGoogleCloud, parseServiceAccountJson, urlDoConectorGcp, type GoogleCloudAccount } from '../server/tools/googleCloudAccounts.js';
import { buildSystemAppend } from '../server/claude/header.js';

const saJson = JSON.stringify({ type: 'service_account', project_id: 'mf-saude', client_email: 'orion@mf-saude.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
const mfSaude: GoogleCloudAccount = { id: 1, label: 'MF Saude', project_id: 'mf-saude', client_email: 'orion@mf-saude.iam.gserviceaccount.com', email: 'bayerlstudio@gmail.com', sa_json: saJson, notes: 'Owner no projeto MF Saude' };

describe('contas Google Cloud (conector simples)', () => {
  it('só aceita JSON de service account com type, client_email e private_key', () => {
    expect(parseServiceAccountJson(saJson)?.client_email).toBe('orion@mf-saude.iam.gserviceaccount.com');
    expect(parseServiceAccountJson('{"type":"user"}')).toBeNull();
    expect(parseServiceAccountJson('não é json')).toBeNull();
    expect(maskServiceAccountJson(saJson)).toBe('orion@mf-saude.iam.gserviceaccount.com');
  });
  it('nome do conector é gcp-<slug do label> e a URL é o proxy local', () => {
    expect(nomeConectorGoogleCloud('MF Saude')).toBe('gcp-mf-saude');
    expect(nomeConectorGoogleCloud('Bayerl Studio!')).toBe('gcp-bayerl-studio');
    expect(nomeConectorGoogleCloud('')).toBe('gcp-conta');
    expect(urlDoConectorGcp('gcp-mf-saude')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/conector\/gcp-mf-saude$/);
    expect(contaDoConectorGcp('gcp-mf-saude', [mfSaude])).toBe(mfSaude);
    expect(contaDoConectorGcp('gcp-outra', [mfSaude])).toBeNull();
  });
  it('bloqueia só apagar projeto ou organização inteira', () => {
    expect(bloqueadoNoConectorGcp('DELETE', 'cloudresourcemanager.googleapis.com/v1/projects/mf-saude')).toBe(true);
    expect(bloqueadoNoConectorGcp('DELETE', 'cloudresourcemanager.googleapis.com/v3/organizations/123')).toBe(true);
    expect(bloqueadoNoConectorGcp('DELETE', 'compute.googleapis.com/v1/projects/mf-saude/zones/us-c1/instances/x')).toBe(false);
    expect(bloqueadoNoConectorGcp('GET', 'cloudresourcemanager.googleapis.com/v1/projects/mf-saude')).toBe(false);
  });
  it('a URL do proxy e a explicação de cada conta entram no header da sessão, sem a chave', () => {
    const txt = buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', googleCloud: googleCloudParaHeader([mfSaude]) });
    expect(txt).toContain('- gcp-mf-saude: ' + urlDoConectorGcp('gcp-mf-saude') + ' (projeto mf-saude, e-mail bayerlstudio@gmail.com): Owner no projeto MF Saude');
    expect(txt).not.toContain('private_key');
    expect(buildSystemAppend({ projectName: 'p', projectPath: '/p', createdBy: 'Danilo', googleCloud: [] })).not.toContain('Contas Google Cloud');
  });
});
