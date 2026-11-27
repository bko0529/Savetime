/**
 * 위치 확인 불가 · 주소 입력 (SFR-009). 서버 GET /geocode (카카오 로컬을 서버가 대신 부름, 앱에 키 없음).
 * 고른 주소의 좌표를 요청·추천 기준 위치로 쓴다. 입력한 주소는 저장하지 않는다 (서버도 남기지 않음, SER-012)
 */
import { MapPin, Search, X } from 'lucide-react-native';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, api } from '../../api/client';
import { BigButton, Field, Notice, Tile, Txt } from '../../ui/kit';
import { color, font, radius, text } from '../../ui/theme';
import { setManualLocation, type LatLng } from '../location';

type Candidate = { address: string; location: LatLng };

export function AddressSheet({
  onClose,
  onPicked,
}: {
  onClose: () => void;
  onPicked: (label: string) => void;
}) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Candidate[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const search = async () => {
    if (!q.trim()) return setErr('주소나 장소 이름을 넣어 주세요');
    setBusy(true);
    setErr('');
    try {
      const r = await api<Candidate[]>('GET', `/geocode?address=${encodeURIComponent(q.trim())}`);
      setList(r);
      if (r.length === 0) setErr('주소를 찾을 수 없습니다');
    } catch (e) {
      setList([]);
      setErr(
        e instanceof ApiError && e.code === 'ADDRESS_NOT_FOUND'
          ? '주소를 찾을 수 없습니다'
          : e instanceof Error
            ? e.message
            : '찾지 못했어요',
      );
    } finally {
      setBusy(false);
    }
  };

  const pick = (c: Candidate) => {
    setManualLocation({ at: c.location, label: c.address });
    onPicked(c.address);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(30,33,36,0.45)' }}
        onPress={onClose}
        accessibilityLabel="닫기"
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <SafeAreaView
          edges={['bottom']}
          style={{
            padding: 20,
            gap: 12,
            backgroundColor: color.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
          }}
        >
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Txt style={{ fontFamily: font.extrabold, fontSize: 18 }}>주소로 위치 정하기</Txt>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="주소 입력 닫기"
              style={{ padding: 6 }}
            >
              <X size={20} color={color.muted} />
            </Pressable>
          </View>
          <Txt style={[text.body, { color: color.muted }]}>
            위치를 잡지 못했어요. 지금 있는 곳의 주소나 장소 이름(예: 천안역)을 넣어 주세요.
          </Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field
              style={{ flex: 1 }}
              value={q}
              onChangeText={setQ}
              placeholder="천안시 동남구 신부동"
              returnKeyType="search"
              onSubmitEditing={() => void search()}
              accessibilityLabel="주소 검색"
            />
            <BigButton
              busy={busy}
              onPress={() => void search()}
              style={{ width: 'auto', height: 52, paddingHorizontal: 16 }}
              icon={<Search size={16} color={color.primaryText} />}
              accessibilityLabel="주소 찾기"
            >
              찾기
            </BigButton>
          </View>
          {err ? <Notice tone="warn">{err}</Notice> : null}
          {list.length > 0 ? (
            <Tile divided>
              {list.map((c) => (
                <Pressable
                  key={`${c.address}-${c.location.lat}`}
                  onPress={() => pick(c)}
                  accessibilityRole="button"
                  accessibilityLabel={`${c.address} 고르기`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 }}
                >
                  <MapPin size={16} color={color.accentDeep} />
                  <Txt style={{ flex: 1, fontFamily: font.semibold, fontSize: 15 }}>
                    {c.address}
                  </Txt>
                </Pressable>
              ))}
            </Tile>
          ) : null}
          <View style={{ borderRadius: radius.sm }} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
