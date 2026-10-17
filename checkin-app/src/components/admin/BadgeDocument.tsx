"use client";

import React, { useMemo } from 'react';
import { Document, Page, Text, View, StyleSheet, Image, Font } from '@react-pdf/renderer';

// Font registration for a modern sans-serif look
Font.register({
    family: 'Roboto',
    src: 'https://cdnjs.cloudflare.com/ajax/libs/ink/3.1.10/fonts/Roboto/roboto-regular-webfont.ttf'
});
Font.register({
    family: 'Roboto-Bold',
    src: 'https://cdnjs.cloudflare.com/ajax/libs/ink/3.1.10/fonts/Roboto/roboto-bold-webfont.ttf'
});

// Full brand logo (mark + "innovation treehouse" wordmark). Static asset → reachable without auth
// gating (middleware exempts paths with a file extension). PNG because @react-pdf can't decode webp.
const TREEHOUSE_LOGO_URL = '/brand/treehouse-logo-full.png';

// Create styles for Avery 5390 (8.5x11 paper, 8 badges per page)
// 2 columns x 3.5" wide = 7"
// 4 rows x 2.25" high = 9"
// Margins: 0.75" horizontal (Left 0.75, Right 0.75) and 1" vertical (Top 1, Bottom 1)
const styles = StyleSheet.create({
    page: {
        paddingTop: '1in',
        paddingBottom: '1in',
        paddingLeft: '0.75in',
        paddingRight: '0.75in',
        flexDirection: 'row',
        flexWrap: 'wrap',
        backgroundColor: '#FFFFFF',
    },
    badge: {
        width: '3.5in',
        height: '2.25in',
        padding: '0.2in',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        position: 'relative'
    },
    badgeBack: {
        width: '3.5in',
        height: '2.25in',
        display: 'flex',
        flexDirection: 'column',
        // The clip covers the top third of the badge back, so pad past 0.75in of the
        // 2.25in height and centre the QR in the clip-free bottom two thirds.
        paddingTop: '0.75in',
        justifyContent: 'center',
        alignItems: 'center',
        position: 'relative'
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    yearText: {
        fontFamily: 'Roboto',
        fontSize: 9,
        color: '#555555',
        marginLeft: 6,
    },
    nameContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    nameText: {
        fontFamily: 'Roboto-Bold',
        fontSize: 22,
        textAlign: 'center',
    },
    logo: {
        width: 150,
        height: 71, // source 1198x568 ≈ 2.11:1
    },
    qrCode: {
        // Sized with the id caption to fit the 1.5in (108pt) clip-free strip.
        width: 80,
        height: 80,
    },
    qrIdText: {
        fontFamily: 'Roboto',
        fontSize: 10,
        marginTop: 5,
        color: '#555',
    }
});

interface ParticipantBadge {
    id: number;
    // Already resolved by the page against the ACTIVE roster. Computing it here would
    // make it a function of the current print batch, which is the #1625 bug.
    displayName: string;
    // The membership year, per badge — null for a household that has not settled this
    // renewal cycle, which prints no year at all rather than an unearned one.
    year: string | null;
    qrDataUri: string;
}

export default function BadgeDocument({ badges }: { badges: ParticipantBadge[] }) {
    // We chunk the badges into arrays of 8, because Avery 5390 takes 8 per page
    const chunkedBadges: ParticipantBadge[][] = useMemo(() => {
        const chunks = [];
        for (let i = 0; i < badges.length; i += 8) {
            chunks.push(badges.slice(i, i + 8));
        }
        return chunks;
    }, [badges]);

    return (
        <Document>
            {chunkedBadges.map((chunk, pageIndex) => {
                // Determine the layout for the front page
                // It goes top-left, top-right, down the rows.
                // Indices:
                // 0 1
                // 2 3
                // 4 5
                // 6 7

                // Determine the layout for the back page
                // We need to mirror horizontally:
                // 1 0
                // 3 2
                // 5 4
                // 7 6
                const backChunk = new Array(8).fill(null);
                for (let i = 0; i < 8; i++) {
                    if (chunk[i]) {
                        // Even indices (left column) go to odd (right column)
                        // Odd indices (right column) go to even (left column)
                        const isEven = i % 2 === 0;
                        const targetIdx = isEven ? i + 1 : i - 1;
                        backChunk[targetIdx] = chunk[i];
                    }
                }

                return (
                    <React.Fragment key={`page-${pageIndex}`}>
                        {/* FRONT PAGE */}
                        <Page size="LETTER" style={styles.page}>
                            {chunk.map((badge, idx) => (
                                <View style={styles.badge} key={`front-${idx}`}>
                                    <View style={styles.headerRow}>
                                        {/* eslint-disable-next-line jsx-a11y/alt-text */}
                                        <Image src={TREEHOUSE_LOGO_URL} style={styles.logo} />
                                        {badge.year ? <Text style={styles.yearText}>{badge.year}</Text> : null}
                                    </View>

                                    <View style={styles.nameContainer}>
                                        <Text style={styles.nameText}>{badge.displayName}</Text>
                                    </View>
                                </View>
                            ))}
                            {/* Empty views for the remainder of the 8 so layout doesn't break */}
                            {Array.from({ length: 8 - chunk.length }).map((_, i) => (
                                <View style={styles.badge} key={`empty-front-${i}`} />
                            ))}
                        </Page>

                        {/* BACK PAGE */}
                        <Page size="LETTER" style={styles.page}>
                            {backChunk.map((badge, idx) => (
                                <View style={styles.badgeBack} key={`back-${idx}`}>
                                    {badge ? (
                                        <>
                                            {/* eslint-disable-next-line jsx-a11y/alt-text */}
                                            <Image src={badge.qrDataUri} style={styles.qrCode} />
                                            <Text style={styles.qrIdText}>ID: {badge.id}</Text>
                                        </>
                                    ) : null}
                                </View>
                            ))}
                        </Page>
                    </React.Fragment>
                );
            })}
        </Document>
    );
}
