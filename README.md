# DeskMate

화면 한쪽에서 함께하는 작은 macOS 데스크톱 동료입니다.
캐릭터가 돌아다니며 퇴근까지의 진행률과 할 일을 알려주고, 원하면 AI와 대화할 수도 있습니다.

<table>
  <tr><th>데스크톱 동료</th><th>날짜별 할 일</th><th>AI 대화</th></tr>
  <tr>
    <td><img src="docs/images/companion.png" alt="HP와 말풍선을 표시하는 데스크톱 캐릭터" width="260" /></td>
    <td><img src="docs/images/memos.png" alt="날짜를 선택해 할 일을 관리하는 메모 화면" width="260" /></td>
    <td><img src="docs/images/chat.png" alt="전용 창에서 질문과 답변을 이어가는 대화 화면" width="260" /></td>
  </tr>
</table>

예제 메모와 데모 대화를 사용한 실제 앱 화면입니다.

## 할 수 있는 일

- **데스크톱 펫** — 다섯 캐릭터와 네 가지 크기, 드래그와 자유 이동
- **퇴근 HP** — 설정한 근무시간의 진행률을 다섯 단계 색상으로 표시
- **날짜별 할 일** — 오늘 목록, 이전 기록, 완료·수정과 일회성·반복 알림
- **AI 대화** — Codex CLI로 이야기를 이어가고 메모·근무시간 조회와 변경 요청
- **AI로 커스터마이징** — 각자의 Agent로 캐릭터 외형·동작이나 연결 어댑터 수정

## 시작하기

macOS와 Node.js 24가 필요합니다. 저장소를 내려받아 실행하세요.

```sh
git clone https://github.com/didxodnr0769-bom/deskmate.git
cd deskmate
npm ci
npm run dev
```

메모·근무시간·캐릭터는 AI 연결 없이 사용할 수 있습니다.
현재는 소스를 직접 빌드하는 방식이며, 설치용 앱 다운로드는 제공하지 않습니다.

## 기본 조작

| 조작 | 기능 |
| --- | --- |
| 캐릭터 클릭 / `⌘⇧Enter` | 대화 창 열기 |
| 캐릭터 우클릭 / Control+클릭 | 근무·메모·캐릭터·설정 열기 |
| 캐릭터 드래그 | 원하는 위치나 다른 모니터로 이동 |
| `⌘⇧Space` | 숨기기·다시 표시 |

캐릭터 종류·크기는 **캐릭터**, 자유 이동·숨기기 단축키는 **설정**에서 변경합니다.

## AI 연결은 선택

[Codex CLI](https://developers.openai.com/codex/cli)를 설치하고 터미널에서 `codex login`을 실행하세요.
대화 창에서 연결을 확인한 뒤 **“10분 뒤에 물 마시라고 알려줘”**처럼 요청할 수 있습니다.
연결 조건과 데이터 전달 범위는 [사용 안내](docs/usage.md#ai-대화)에서 확인하세요.

## 더 알아보기

- [사용법·알림·로컬 데이터·앱 만들기](docs/usage.md)
- [캐릭터 바꾸기](docs/character-guide.md)
- [AI 연결과 다른 Agent로 교체하기](docs/agent-provider-guide.md)
- [구조와 구현 범위](docs/architecture.md)
- [검증 결과와 남은 수동 점검](docs/verification.md)
- [보안·데이터 처리와 공개 점검 범위](docs/security.md)

소스를 수정할 때는 [AGENTS.md](AGENTS.md)와 [Agent 안내](.agents/README.md)를 먼저 읽어 주세요.

## 라이선스

프로젝트 코드는 [MIT 라이선스](LICENSE)로 제공합니다. 캐릭터 이미지의 제작 정보와 적용 범위는 [이미지 안내](docs/assets.md)를 확인하세요.
외부 구성요소에는 각자의 라이선스가 적용되며 [타사 소프트웨어 고지](THIRD_PARTY_NOTICES.md)를 함께 제공합니다.
