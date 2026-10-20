# 타사 소프트웨어 고지

프로젝트의 자체 코드는 루트 `LICENSE`의 MIT 라이선스를 따릅니다. 외부 구성요소는 각 원본 라이선스를 유지합니다.

macOS 앱에는 Electron, Chromium 및 Electron에 포함된 구성요소와 React, React DOM, Scheduler가 들어갑니다. 정확한 설치 버전은 `package-lock.json`을 기준으로 합니다.

`npm run package:mac`은 설치된 패키지에서 다음 원본 고지를 복사하여 앱의 `Contents/Resources/THIRD_PARTY_NOTICES/`에 동봉합니다.

- `Electron-LICENSE`: Electron 원본 `LICENSE`
- `LICENSES.chromium.html`: Electron이 제공하는 Chromium 및 포함 구성요소 고지
- `react-LICENSE`, `react-dom-LICENSE`, `scheduler-LICENSE`: 각 패키지의 원본 `LICENSE`

프로젝트 `LICENSE`와 이 안내도 `Contents/Resources/`에 포함합니다. 소스 압축본에는 외부 패키지 코드와 바이너리가 없으며, 개발 도구와 의존성은 `npm ci`로 설치합니다.
