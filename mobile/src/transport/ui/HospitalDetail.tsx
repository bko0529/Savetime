/**
 * S-07 병원 상세 (SFR-007, Lovable hospital-detail 그대로): 진료과 · 연락처(직통/대표) ·
 * 병상 현황(응급실/중환자실/수술실) · 중증질환 진료가능 항목(공공 데이터 표기 그대로)을 아래에서 올라오는 창으로.
 */
import { BedDouble, CheckCircle2, Phone, ShieldAlert, Stethoscope, X } from 'lucide-react-native';
import { useEffect } from 'react';
import { Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BigButton, Tile, Txt } from '../../ui/kit';
import { color, font, radius, text } from '../../ui/theme';
import { loadHospitalDetail } from '../engine';
import { bedAvail, capCount, type Hospital } from '../hospitals';

const call = (num: string) => {
  if (num) void Linking.openURL(`tel:${num.replace(/[^\d+]/g, '')}`);
};

export function HospitalDetail({
  h,
  approved,
  note,
  onClose,
  onConfirm,
  onPhone,
}: {
  h: Hospital;
  approved?: boolean;
  note?: string;
  onClose: () => void;
  onConfirm?: () => void;
  onPhone?: () => void;
}) {
  // 열 때 서버에서 진료과·진료가능 항목·대표 전화를 읽어 채운다 (SFR-007)
  useEffect(() => {
    if (h.id) void loadHospitalDetail(h.id);
  }, [h.id]);
  const cc = capCount(h);
  const beds = [
    { k: '응급실', v: h.er },
    { k: '중환자실', v: h.icu },
    { k: '수술실', v: h.or },
  ];
  const noBed = !h.er && !h.icu && !h.or;
  const chip = (t: string) => (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: color.surface2,
      }}
    >
      <Txt style={{ fontSize: 11, fontFamily: font.bold }}>{t}</Txt>
    </View>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(30,33,36,0.45)' }}
        onPress={onClose}
        accessibilityLabel="닫기"
      />
      <SafeAreaView
        edges={['bottom']}
        style={{
          maxHeight: '92%',
          backgroundColor: color.card,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
        }}
      >
        <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
          <View
            style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: color.borderStrong }}
          />
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Txt style={{ fontFamily: font.extrabold, fontSize: 20 }} accessibilityRole="header">
                {h.name}
              </Txt>
              <View style={{ marginTop: 6, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {chip(`${h.km}km`)}
                {chip(`약 ${h.min}분`)}
                <Txt style={[text.small, { color: color.muted }]}>{h.grade}</Txt>
              </View>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="닫기"
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: color.surface2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={20} color={color.muted} />
            </Pressable>
          </View>
          {note ? (
            <View style={{ padding: 12, borderRadius: radius.sm, backgroundColor: color.infoSoft }}>
              <Txt style={{ fontFamily: font.semibold, fontSize: 14 }}>{note}</Txt>
            </View>
          ) : null}

          <Tile style={{ padding: 16 }}>
            <Head icon={<BedDouble size={14} color={color.muted} />}>병상 현황</Head>
            <View style={{ marginTop: 10, flexDirection: 'row', gap: 8 }}>
              {beds.map((b) => {
                const a = bedAvail(b.v);
                return (
                  <View
                    key={b.k}
                    style={{
                      flex: 1,
                      alignItems: 'center',
                      paddingVertical: 12,
                      borderRadius: radius.sm,
                      backgroundColor: color.surface,
                    }}
                  >
                    <Txt style={{ fontSize: 11, color: color.muted }}>{b.k}</Txt>
                    <Txt
                      style={{
                        marginTop: 4,
                        fontFamily: font.extrabold,
                        fontSize: a === null ? 12 : 18,
                        color: a === 0 ? color.destructive : color.foreground,
                      }}
                    >
                      {a === null ? '정보 없음' : b.v}
                    </Txt>
                  </View>
                );
              })}
            </View>
            <Txt style={[text.caption, { marginTop: 10, color: color.muted }]}>
              {noBed
                ? '이 병원은 병상 정보가 없어요 · 전화로 확인하세요'
                : `참고용 정보 · 병상 기준 ${h.bedsAt}`}
            </Txt>
          </Tile>

          <Tile style={{ padding: 16 }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Head icon={<Stethoscope size={14} color={color.muted} />}>
                중증질환 진료가능 항목
              </Head>
              <Txt style={{ fontFamily: font.extrabold, fontSize: 14 }}>
                {cc.available}/{cc.total}
              </Txt>
            </View>
            {h.caps.length === 0 ? (
              <Txt style={[text.small, { marginTop: 8, color: color.muted }]}>
                {cc.total > 0
                  ? '불러오는 중…'
                  : '공공 데이터에 없는 병원이에요 · 전화로 확인해야 알 수 있어요'}
              </Txt>
            ) : (
              <View style={{ marginTop: 10, gap: 2 }}>
                {h.caps.map((c, i) => (
                  <View
                    key={c.name}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      paddingHorizontal: 4,
                      paddingVertical: 6,
                      borderRadius: 6,
                      backgroundColor: i % 2 === 0 ? 'rgba(241,245,249,0.7)' : 'transparent',
                    }}
                  >
                    <Txt
                      style={{
                        fontSize: 14,
                        fontFamily: c.available ? font.bold : font.regular,
                        color: c.available ? color.foreground : color.muted,
                        textDecorationLine: c.available ? 'none' : 'line-through',
                      }}
                    >
                      {c.name}
                    </Txt>
                    <View
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        borderRadius: 999,
                        backgroundColor: c.available ? color.successSoft : color.surface2,
                      }}
                    >
                      <Txt
                        style={{
                          fontFamily: font.extrabold,
                          fontSize: 11,
                          color: c.available ? color.success : color.muted,
                        }}
                      >
                        {c.available ? '가능' : '불가'}
                      </Txt>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Tile>

          {h.depts.length > 0 ? (
            <Tile style={{ padding: 16 }}>
              <Head>진료과</Head>
              <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {h.depts.map((d) => (
                  <View key={d}>{chip(d)}</View>
                ))}
              </View>
            </Tile>
          ) : null}

          <Tile style={{ padding: 16, gap: 8 }}>
            <Head>연락처</Head>
            {h.erPhone ? (
              <BigButton
                variant="accent"
                onPress={() => call(h.erPhone)}
                icon={<Phone size={18} color={color.accentText} />}
                accessibilityLabel={`응급실 직통 ${h.erPhone} 전화`}
              >
                {`응급실 직통 ${h.erPhone}`}
              </BigButton>
            ) : (
              <Txt style={[text.small, { color: color.muted }]}>응급실 직통 번호가 없어요</Txt>
            )}
            {h.mainPhone ? (
              <BigButton
                variant="outline"
                onPress={() => call(h.mainPhone)}
                icon={<Phone size={18} color={color.muted} />}
              >
                {`대표 ${h.mainPhone}`}
              </BigButton>
            ) : null}
          </Tile>

          <View style={{ gap: 8, paddingTop: 4 }}>
            {approved && onConfirm ? (
              <BigButton
                variant="success"
                size="lg"
                onPress={onConfirm}
                icon={<CheckCircle2 size={20} color={color.accentText} />}
              >
                이 병원으로 확정
              </BigButton>
            ) : null}
            {onPhone ? (
              <BigButton
                variant={approved ? 'outline' : 'accent'}
                size="lg"
                onPress={onPhone}
                icon={<Phone size={20} color={approved ? color.foreground : color.accentText} />}
              >
                전화 확인
              </BigButton>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <ShieldAlert size={14} color={color.muted} style={{ marginTop: 2 }} />
            <Txt style={[text.caption, { flex: 1, color: color.muted }]}>
              병상 · 진료가능 항목은 공공 응급의료 데이터 기준으로, 실제와 다를 수 있어요.
            </Txt>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Head({ children, icon }: { children: string; icon?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {icon}
      <Txt style={{ fontFamily: font.bold, fontSize: 11, letterSpacing: 0.5, color: color.muted }}>
        {children}
      </Txt>
    </View>
  );
}
