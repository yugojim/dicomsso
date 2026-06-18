const host = window.location.hostname;
const scheme = window.location.protocol;
const keycloakUrl = `${scheme}//${host}:8080`;
const portalUrl = `${scheme}//${host}:8088`;
const ohifUrl = `${scheme}//${host}:3000`;

window.config = {
  routerBasename: '/',
  showStudyList: true,
  oidc: [
    {
      authority: `${keycloakUrl}/realms/dicom`,
      client_id: 'dicom-portal',
      redirect_uri: `${ohifUrl}/callback`,
      response_type: 'id_token token',
      scope: 'openid profile email',
      post_logout_redirect_uri: `${ohifUrl}/`,
      automaticSilentRenew: true,
      silent_redirect_uri: `${ohifUrl}/silent-refresh.html`,
    },
  ],
  servers: {
    dicomWeb: [
      {
        name: 'Orthanc',
        type: 'dicomWeb',
        active: true,
        wadoUriRoot: `${portalUrl}/wado`,
        qidoRoot: `${portalUrl}/dicom-web`,
        wadoRoot: `${portalUrl}/dicom-web`,
        qidoSupportsIncludeField: false,
        supportsFuzzyMatching: false,
        supportsWildcard: false,
        enableStudyLazyLoad: true,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        omitQuotationForMultipartRequest: true,
        requestOptions: {
          requestFromBrowser: true,
        },
      },
    ],
  },
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'orthanc',
      configuration: {
        friendlyName: 'Orthanc',
        name: 'Orthanc',
        qidoRoot: `${portalUrl}/dicom-web`,
        wadoRoot: `${portalUrl}/dicom-web`,
        wadoUriRoot: `${portalUrl}/wado`,
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: false,
        omitQuotationForMultipartRequest: true,
      },
    },
  ],
  defaultDataSourceName: 'orthanc',
};
