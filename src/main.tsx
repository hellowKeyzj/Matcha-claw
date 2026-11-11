const presentation = new URLSearchParams(window.location.search).has('app-view');

if (presentation) {
  void import('./plugins/application-plugins/Presentation').then(({ mountPresentation }) => mountPresentation());
} else {
  void import('./main-app');
}
